import { ExternalLink } from 'lucide-react'

import {
  activityDot,
  groupActivityByDay,
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
 * The grouping, the relative times, and the dot mapping are all in
 * `../lib/activityFeed.ts`, where they are drilled. This file is the painting.
 */

/** One row, plus the link the host resolved for it. */
export interface ActivityFeedItem extends ActivityFeedEntry {
  /** Where the transaction can be looked at, when the host could build one. */
  link?: { label: string; href: string }
}

export interface ActivityFeedProps {
  entries: readonly ActivityFeedItem[]
}

export default function ActivityFeed(props: ActivityFeedProps) {
  const { entries } = props
  const groups = groupActivityByDay(entries)

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
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  )
}
