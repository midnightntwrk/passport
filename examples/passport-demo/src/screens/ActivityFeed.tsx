import { ChevronDown, ExternalLink, RotateCcw } from 'lucide-react'
import { useState } from 'react'

import {
  activityDot,
  activityMoreLabel,
  activityPage,
  ACTIVITY_VISIBLE,
  nextActivityLimit,
  relativeTime,
  type ActivityFeedEntry,
} from '../lib/activityFeed.js'
import './home.css'

/**
 * The activity trail, under the apps grid on Home.
 *
 * Passport has written this trail since it had anything to write: `addActivity`
 * in `App.tsx` records a row on every transfer, every registration, every
 * backup, and every failure of the three. Until 2026/08/30 nothing rendered it
 * — the rows were written into React state and read by nobody — which is the
 * defect this screen closes.
 *
 * WHAT IT IS FOR, AND WHAT THAT RULES OUT
 * ---------------------------------------
 * It is the answer to "what happened to my money", asked after the toast has
 * gone. So it is a calm list rather than a feed: no counters, no badges, no
 * colour beyond the one dot, and nothing on it moves except the dot on a row
 * that is genuinely still in flight.
 *
 * Every row carries a plain-English label, how long ago it happened, and — when
 * it has a transaction behind it — one small link out to the explorer. The link
 * is the ONLY machinery on the surface, and it is a destination rather than an
 * identifier: the 64-character hash it goes to is never printed here, on the
 * same rule that took the hashes off the identity card.
 *
 * PAGING (2026/09/01). "You should put a pagination on the activity." The trail
 * opened on ten rows and stored fifty, so forty of them were an answer nobody
 * could reach. A press reveals the next ten, in place — the day headings are
 * recomputed over the whole visible set rather than appended to, so a day that
 * straddles a page boundary stays one heading rather than printing "Today"
 * twice with a fold between them.
 *
 * The only state this file holds is how far down the trail the reader has
 * asked to go. Everything else — which rows that is, how many are behind them,
 * what the control says, and whether there is a control at all — comes from
 * `activityPage` and `activityMoreLabel`.
 *
 * The grouping, the relative times, the dot mapping, and the paging rules are
 * all in `../lib/activityFeed.ts`, where they are drilled. This file is the
 * painting.
 */

/** One row, plus the link the host resolved for it. */
export interface ActivityFeedItem extends ActivityFeedEntry {
  /** Where the transaction can be looked at, when the host could build one. */
  link?: { label: string; href: string }
  /**
   * The action a row that reports something UNFINISHED offers, where the host
   * has one to give — today, only the opening balance that never arrived.
   *
   * A trail is a record, so this is deliberately rare: a row that failed and
   * cannot be re-run says so and stops, exactly as it always has. What earns a
   * control is a row whose failure is still fixable and whose fix nothing else
   * on the screen offers — which was the opening grant's position until
   * 2026/09/02, when it could time out after ten minutes of trying and leave
   * the Passport with a name, a stablecoin, and no NIGHT, with nowhere at all
   * to ask again. The host decides which row that is (`activationRetryRowId`
   * in `../lib/activation.ts`); this file paints the answer.
   */
  retry?: {
    label: string
    run: () => void
    /**
     * True while the ask is still running. The opening grant is PATIENT — it
     * keeps trying for ten minutes — and it is silent while it waits, so
     * without this the row would answer a second press by doing nothing with
     * nothing on screen to say why.
     */
    busy?: boolean
  }
}

export interface ActivityFeedProps {
  entries: readonly ActivityFeedItem[]
}

export default function ActivityFeed(props: ActivityFeedProps) {
  const { entries } = props
  /* How far down the trail the reader has asked to go. Collapsed on every
     visit and never remembered, on the rule the balance list already keeps: a
     trail is opened to see what just happened, and a Passport that reopened
     forty rows deep because of a press last Tuesday would be answering a
     question nobody asked twice. */
  const [limit, setLimit] = useState(ACTIVITY_VISIBLE)
  const { groups, remaining } = activityPage(entries, limit)
  const more = activityMoreLabel(remaining)

  return (
    <section className="mnhome-activity" aria-labelledby="mnhome-activity-title">
      <p className="mnhome-micro" id="mnhome-activity-title">
        Activity
      </p>
      {groups.length === 0 ? (
        /* One quiet line, not a box. An empty trail is not a problem to be
           announced — it is a Passport that has not done anything yet, and a
           bordered panel around that sentence would give it a weight it has
           not earned. */
        <p className="mnhome-activity-empty">
          Nothing here yet. What you send, receive, and register will appear here.
        </p>
      ) : (
        groups.map((group) => (
          <div className="mnhome-activity-day" key={group.heading}>
            <p className="mnhome-activity-heading">{group.heading}</p>
            <ul className="mnhome-activity-list">
              {group.entries.map((entry) => {
                const item = entry as ActivityFeedItem
                const tone = activityDot(entry.status)
                return (
                  <li className="mnhome-activity-row" key={entry.id} data-tone={tone}>
                    <span
                      className="mnhome-activity-dot"
                      aria-hidden="true"
                      data-tone={tone}
                    />
                    <span className="mnhome-activity-text">
                      <span className="mnhome-activity-label">{entry.label}</span>
                      {entry.detail ? (
                        <span className="mnhome-activity-detail">{entry.detail}</span>
                      ) : null}
                    </span>
                    <span className="mnhome-activity-side">
                      <span className="mnhome-activity-when">
                        {relativeTime(entry.createdAt)}
                      </span>
                      {item.link ? (
                        <a
                          className="mnhome-activity-view"
                          href={item.link.href}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>View</span>
                          <ExternalLink size={11} aria-hidden="true" />
                        </a>
                      ) : null}
                      {/* Shaped like the link beside it rather than as a
                          button, because it sits in the same column on the same
                          calm list — the difference is that this one acts here
                          instead of leaving. Its accessible name carries the
                          row's own label, so a reader moving by control hears
                          which thing is being asked for again rather than four
                          identical "Retry"s. */}
                      {item.retry ? (
                        <button
                          type="button"
                          className="mnhome-activity-retry"
                          onClick={item.retry.run}
                          disabled={item.retry.busy === true}
                          aria-label={`${item.retry.label}: ${entry.label}`}
                        >
                          <RotateCcw
                            size={11}
                            aria-hidden="true"
                            className={item.retry.busy === true ? 'mnhome-send-spinner' : undefined}
                          />
                          <span>{item.retry.busy === true ? 'Asking…' : item.retry.label}</span>
                        </button>
                      ) : null}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}

      {/* GONE, not disabled, once the trail is whole: `activityMoreLabel`
          answers null and there is nothing to render. A control left behind
          reading "Show 0 more" would be furniture claiming there is more to
          see. */}
      {more ? (
        <button
          type="button"
          className="mnhome-activity-more"
          onClick={() => setLimit(nextActivityLimit)}
        >
          <ChevronDown size={13} aria-hidden="true" />
          <span>{more.action}</span>
          {more.hint ? <span className="mnhome-activity-left">{more.hint}</span> : null}
        </button>
      ) : null}
    </section>
  )
}
