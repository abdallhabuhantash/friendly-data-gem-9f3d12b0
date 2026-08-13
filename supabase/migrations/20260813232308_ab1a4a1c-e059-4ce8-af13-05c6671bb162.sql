-- 1. Events may belong to an exam session that was actively armed at detection time.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS exam_session_id uuid REFERENCES public.exam_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS events_exam_session_id_idx ON public.events (exam_session_id);

-- 2. Event -> anonymous subject attribution (audit facts written by the AI service).
CREATE TABLE public.event_subjects (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  exam_session_id uuid NOT NULL REFERENCES public.exam_sessions(id) ON DELETE CASCADE,
  session_subject_id uuid NOT NULL REFERENCES public.session_subjects(id) ON DELETE CASCADE,
  participant_index integer NOT NULL DEFAULT 1,
  participant_role text NOT NULL DEFAULT 'subject',
  link_method text NOT NULL DEFAULT 'frame_subject_ownership',
  link_confidence numeric,
  linked_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT event_subjects_participant_index_positive CHECK (participant_index >= 1),
  CONSTRAINT event_subjects_unique_subject UNIQUE (event_id, session_subject_id),
  CONSTRAINT event_subjects_unique_participant UNIQUE (event_id, participant_index)
);
CREATE INDEX event_subjects_subject_idx ON public.event_subjects (session_subject_id);
CREATE INDEX event_subjects_event_idx ON public.event_subjects (event_id);

GRANT SELECT ON public.event_subjects TO authenticated;
GRANT ALL ON public.event_subjects TO service_role;
ALTER TABLE public.event_subjects ENABLE ROW LEVEL SECURITY;
CREATE POLICY event_subjects_select ON public.event_subjects
  FOR SELECT TO authenticated USING (public.has_any_role(auth.uid()));

-- 3. Human resolution history: anonymous subject -> roster student.
CREATE TABLE public.subject_identity_resolutions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_session_id uuid NOT NULL REFERENCES public.exam_sessions(id) ON DELETE CASCADE,
  session_subject_id uuid NOT NULL REFERENCES public.session_subjects(id) ON DELETE CASCADE,
  exam_roster_student_id uuid NOT NULL REFERENCES public.exam_roster_students(id) ON DELETE CASCADE,
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  revoked_by uuid REFERENCES auth.users(id),
  correction_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subject_identity_active_subject_idx
  ON public.subject_identity_resolutions (exam_session_id, session_subject_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX subject_identity_active_student_idx
  ON public.subject_identity_resolutions (exam_session_id, exam_roster_student_id)
  WHERE revoked_at IS NULL;
CREATE INDEX subject_identity_subject_idx
  ON public.subject_identity_resolutions (session_subject_id);

GRANT SELECT ON public.subject_identity_resolutions TO authenticated;
GRANT ALL ON public.subject_identity_resolutions TO service_role;
ALTER TABLE public.subject_identity_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY subject_identity_resolutions_select ON public.subject_identity_resolutions
  FOR SELECT TO authenticated USING (public.has_any_role(auth.uid()));

-- 4. Controlled resolution operation. resolved_by is derived from the session,
--    never from client input, and both sides must share one exam session.
CREATE OR REPLACE FUNCTION public.resolve_subject_identity(
  _session_subject_id uuid,
  _exam_roster_student_id uuid,
  _correction_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor uuid := auth.uid();
  _session uuid;
  _student_session uuid;
  _existing public.subject_identity_resolutions;
  _conflict public.subject_identity_resolutions;
  _new_id uuid;
BEGIN
  IF _actor IS NULL OR NOT public.has_any_role(_actor) THEN
    RAISE EXCEPTION 'Not authorized to resolve subject identity';
  END IF;

  SELECT exam_session_id INTO _session
    FROM public.session_subjects WHERE id = _session_subject_id;
  IF _session IS NULL THEN
    RAISE EXCEPTION 'Anonymous subject not found';
  END IF;

  SELECT exam_session_id INTO _student_session
    FROM public.exam_roster_students WHERE id = _exam_roster_student_id;
  IF _student_session IS NULL THEN
    RAISE EXCEPTION 'Roster student not found';
  END IF;

  IF _student_session <> _session THEN
    RAISE EXCEPTION 'Roster student belongs to a different exam session';
  END IF;

  SELECT * INTO _existing FROM public.subject_identity_resolutions
   WHERE session_subject_id = _session_subject_id AND revoked_at IS NULL
   LIMIT 1;

  IF _existing.id IS NOT NULL THEN
    IF _existing.exam_roster_student_id = _exam_roster_student_id THEN
      RETURN _existing.id;
    END IF;
    IF _correction_reason IS NULL OR btrim(_correction_reason) = '' THEN
      RAISE EXCEPTION 'This subject already has an active identity; a correction reason is required';
    END IF;
    -- History is preserved: the previous resolution is superseded, never deleted.
    UPDATE public.subject_identity_resolutions
       SET revoked_at = now(), revoked_by = _actor,
           correction_reason = COALESCE(correction_reason, _correction_reason)
     WHERE id = _existing.id;
  END IF;

  SELECT * INTO _conflict FROM public.subject_identity_resolutions
   WHERE exam_session_id = _session
     AND exam_roster_student_id = _exam_roster_student_id
     AND revoked_at IS NULL
   LIMIT 1;
  IF _conflict.id IS NOT NULL THEN
    RAISE EXCEPTION 'This roster student is already identified as another anonymous subject in this exam session';
  END IF;

  INSERT INTO public.subject_identity_resolutions (
    exam_session_id, session_subject_id, exam_roster_student_id,
    resolved_by, resolved_at, correction_reason
  ) VALUES (
    _session, _session_subject_id, _exam_roster_student_id,
    _actor, now(), NULLIF(btrim(COALESCE(_correction_reason, '')), '')
  ) RETURNING id INTO _new_id;

  RETURN _new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_subject_identity(
  _resolution_id uuid,
  _correction_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _actor uuid := auth.uid();
BEGIN
  IF _actor IS NULL OR NOT public.has_any_role(_actor) THEN
    RAISE EXCEPTION 'Not authorized to revoke subject identity';
  END IF;
  IF _correction_reason IS NULL OR btrim(_correction_reason) = '' THEN
    RAISE EXCEPTION 'A correction reason is required';
  END IF;
  UPDATE public.subject_identity_resolutions
     SET revoked_at = now(), revoked_by = _actor,
         correction_reason = COALESCE(correction_reason, _correction_reason)
   WHERE id = _resolution_id AND revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_subject_identity(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_subject_identity(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_subject_identity(uuid, uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.revoke_subject_identity(uuid, text) TO authenticated, service_role;

-- 5. One joined read for event lists / details: no per-row identity queries.
CREATE VIEW public.event_subject_identity_view
WITH (security_invoker = true) AS
SELECT
  es.id                    AS event_subject_id,
  es.event_id,
  es.exam_session_id,
  es.session_subject_id,
  es.participant_index,
  es.participant_role,
  es.link_method,
  es.link_confidence,
  es.linked_at,
  ss.subject_number,
  ss.subject_label,
  r.id                     AS resolution_id,
  r.exam_roster_student_id,
  r.resolved_at,
  r.resolved_by,
  p.full_name              AS resolved_by_name,
  st.full_name             AS student_full_name,
  st.university_id         AS student_university_id
FROM public.event_subjects es
JOIN public.session_subjects ss ON ss.id = es.session_subject_id
LEFT JOIN public.subject_identity_resolutions r
       ON r.session_subject_id = es.session_subject_id AND r.revoked_at IS NULL
LEFT JOIN public.exam_roster_students st ON st.id = r.exam_roster_student_id
LEFT JOIN public.profiles p ON p.id = r.resolved_by;

GRANT SELECT ON public.event_subject_identity_view TO authenticated;
GRANT SELECT ON public.event_subject_identity_view TO service_role;