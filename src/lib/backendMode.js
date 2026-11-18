export function chooseBackendMode({ demoRequested, configured }) {
  if (demoRequested) return 'local'
  return configured ? 'supabase' : 'unconfigured'
}
