import { useCallback, useEffect, useRef, useState } from 'react'

export function useApiData(loader, deps = [], { enabled = true } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  const reload = useCallback(
    async ({ quiet = false } = {}) => {
      if (!enabled) return
      if (!quiet) {
        setLoading(true)
        setError('')
      }
      try {
        const result = await loaderRef.current()
        setData(result)
        setError('')
      } catch (err) {
        setError(err?.message || 'Something went wrong')
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, ...deps]
  )

  useEffect(() => {
    let cancelled = false
    if (!enabled) {
      setLoading(false)
      return undefined
    }
    setLoading(true)
    setError('')
    loaderRef
      .current()
      .then(result => {
        if (!cancelled) {
          setData(result)
          setError('')
        }
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Something went wrong')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reload, enabled])

  return { data, loading, error, reload }
}
