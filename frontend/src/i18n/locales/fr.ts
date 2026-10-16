const resources = import.meta.glob('./fr/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Record<string, string>>
export default Object.fromEntries(
  Object.entries(resources).map(([path, messages]) => [
    path.split('/').at(-1)!.replace('.json', ''),
    messages,
  ]),
)
