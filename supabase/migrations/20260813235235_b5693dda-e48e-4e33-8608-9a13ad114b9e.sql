DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'event_subjects'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.event_subjects;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'subject_identity_resolutions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.subject_identity_resolutions;
  END IF;
END
$$;