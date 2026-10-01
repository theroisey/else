import { QueryClient } from '@tanstack/react-query'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 15_000,
        gcTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  })
}
