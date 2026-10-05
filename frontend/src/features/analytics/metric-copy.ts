import { copy } from '../../i18n/index'
import type { Workspace } from './models'
type Metric = Workspace['definitions'][number]['name']
// UI explanations for the four supported metrics. Provider metadata remains
// unmodified in the report contract; measurements retain their original meaning.
export function metricCopy(name: Metric) {
  const labels: Record<Metric, { label: string; description: string }> = {
    activeUsers: {
      label: copy('Active users', 'analytics'),
      description: copy(
        'Active users reported by GA4 for the selected period.',
        'analytics',
      ),
    },
    sessions: {
      label: copy('Sessions', 'analytics'),
      description: copy(
        'Sessions started during the selected period, as reported by GA4.',
        'analytics',
      ),
    },
    screenPageViews: {
      label: copy('Views', 'analytics'),
      description: copy(
        'Page and screen views reported by GA4, including repeated views.',
        'analytics',
      ),
    },
    keyEvents: {
      label: copy('Key events', 'analytics'),
      description: copy(
        'Key events reported by GA4. Attribution fractions are retained.',
        'analytics',
      ),
    },
  }
  return labels[name]
}
