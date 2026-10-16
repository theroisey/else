import { createElement, lazy, useState } from 'react'
import type { ComponentType } from 'react'

interface Resource<Module> {
  promise: Promise<Module>
  value?: Module
}
const modules = new WeakMap<() => Promise<unknown>, Resource<unknown>>()

/** Retain public modules only; failed intent loads remain retryable. */
export function loadModule<Module>(loader: () => Promise<Module>) {
  const existing = modules.get(loader) as Resource<Module> | undefined
  if (existing) return existing.promise
  const resource: Resource<Module> = {
    promise: Promise.resolve()
      .then(loader)
      .then((value) => {
        resource.value = value
        return value
      })
      .catch((error) => {
        modules.delete(loader)
        throw error
      }),
  }
  modules.set(loader, resource)
  return resource.promise
}

/** Ready intent loads render synchronously instead of showing a lazy fallback. */
export function lazyPage<Props extends object>(
  loader: () => Promise<{ default: ComponentType<Props> }>,
) {
  const Deferred = lazy(() => loadModule(loader))
  return function DeferredPage(props: Props) {
    // Choose once per mounted page. Switching wrappers later would erase drafts.
    const [Selected] = useState(() => {
      const ready = modules.get(loader) as
        | Resource<{ default: ComponentType<Props> }>
        | undefined
      return ready?.value?.default ?? Deferred
    })
    return createElement(Selected, props)
  }
}
