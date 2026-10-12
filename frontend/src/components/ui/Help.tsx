import { useState } from 'react'
import { useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons'
import { copy, useLocale } from '../../i18n'
import { Dialog } from './Dialog'
import { Button } from './Button'

const guidance = {
  today:
    'Start with work needing attention. Open a request to make a decision or review a delivery. Financial summaries appear only when your permissions allow them.',
  requests:
    'Choose a brand and its website, describe the issue and attach screenshots. Developers accept or explain a rejection, then deliver work for your review. Approval completes the request; a revision keeps every earlier delivery.',
  tasks:
    'Tasks track assigned work and deadlines. A task linked to a technical request follows that request’s delivery and review process. Completion of an ordinary task is a separate action.',
  reminders:
    'Reminders are one-time schedules. Choose the local time and timezone, then mark the reminder completed or dismissed yourself. A due reminder does not automatically complete its linked work.',
  plans:
    'Plans organize milestones and linked tasks. Completing a task or milestone does not automatically complete the plan. Open a milestone to manage its own dates and work.',
  finance:
    'Agreed fees, customer payments and internal transfers are separate. The ROISE share is included in the consulting total, never added as another customer charge. Keep currencies separate and check who collected each payment.',
  billing:
    'Record only actual customer payments. Partial payments reduce the remaining balance; internal partner transfers belong in service finance. Corrections preserve the original payment history. Currencies are never combined.',
  pricing:
    'Pricing versions preserve agreed terms. Review quantities, discounts and taxes before copying a price into a receivable. Copied terms remain fixed even if a later price version changes.',
  recurring:
    'A recurring template creates separate tasks on its schedule. Pausing stops future generation and keeps earlier work. Monthly dates at the end of the month move to that month’s last day.',
  team: 'Assign people to the brands they need. Brand assignments determine access; removing one preserves history and can leave unfinished work needing reassignment. Team leadership does not grant company finance access.',
  websites:
    'Keep each brand’s websites separate. Choose the relevant website when creating a technical request. Archiving preserves history and stops new changes for that website.',
  clients:
    'Open a brand to see its work, websites and authorized finance. Less frequent tools remain under More. Search and filters narrow the list without changing stored records.',
  notifications:
    'Notifications link to work you can currently access. Marking an update as read does not complete its task or review. Browser alerts are optional and keep private details inside the panel.',
  audit:
    'Audit history records who changed a resource and when. It preserves decisions and corrections without showing confidential free-form content. Available entries follow your current permissions.',
  access:
    'Permissions control actions and brand access together. Giving someone a role does not bypass brand scope. Deactivating an account ends its sessions and preserves its recorded activity.',
  analytics:
    'Reports show data from configured integrations. Check the reporting period and last synchronization before making comparisons. Missing provider data is not a zero value.',
  settings:
    'Appearance and browser alerts apply to this browser. Notification categories control future in-app updates. Organization settings require separate authority and do not rewrite existing schedules.',
  workspace:
    'Use Today for daily work, Brands for account details and More for less frequent management tools. Only authorized destinations appear. Search helps you reach a brand or section quickly.',
} as const
export type HelpTopic = keyof typeof guidance

export function Help({ topic }: { topic: HelpTopic }) {
  useLocale()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="help-trigger"
        aria-label={copy('Help for this section', 'help')}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <FontAwesomeIcon icon={faCircleQuestion} aria-hidden="true" />
      </button>
      <Dialog
        open={open}
        title={copy('How this section works', 'help')}
        eyebrow={copy('Section guide', 'help')}
        description={copy(guidance[topic], 'help')}
        onClose={() => setOpen(false)}
      >
        <Button onClick={() => setOpen(false)}>
          {copy('Close', 'common')}
        </Button>
      </Dialog>
    </>
  )
}

export function SectionHelp() {
  const { pathname } = useLocation()
  const topic: HelpTopic = pathname.includes('/requests')
    ? 'requests'
    : pathname.includes('/recurring-tasks')
      ? 'recurring'
      : pathname.includes('/reminders')
        ? 'reminders'
        : pathname.includes('/plans')
          ? 'plans'
          : pathname.includes('/tasks')
            ? 'tasks'
            : /\/(finance|agreements)(\/|$)/.test(pathname)
              ? 'finance'
              : pathname.includes('/billing')
                ? 'billing'
                : pathname.includes('/pricing')
                  ? 'pricing'
                  : pathname.includes('/team')
                    ? 'team'
                    : pathname.includes('/websites')
                      ? 'websites'
                      : pathname.includes('/notifications')
                        ? 'notifications'
                        : pathname.includes('/audit')
                          ? 'audit'
                          : /\/(users|roles|access)(\/|$)/.test(pathname)
                            ? 'access'
                            : /\/(analytics|commerce|marketing|integrations)(\/|$)/.test(
                                  pathname,
                                )
                              ? 'analytics'
                              : pathname.includes('/settings')
                                ? 'settings'
                                : pathname.includes('/clients')
                                  ? 'clients'
                                  : pathname === '/app'
                                    ? 'today'
                                    : 'workspace'
  return <Help key={pathname} topic={topic} />
}
