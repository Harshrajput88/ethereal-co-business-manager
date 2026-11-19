// Supabase warns against awaiting Supabase operations inside onAuthStateChange.
// Run application work after the auth callback has returned and released its lock.
export function deferAuthEvent(callback, schedule = setTimeout) {
  return event => {
    schedule(() => {
      void callback(event)
    }, 0)
  }
}
