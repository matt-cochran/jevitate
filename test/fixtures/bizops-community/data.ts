/**
 * #580: seed data for the offline Bizops fixture — a fictional "community" support inbox.
 *
 * Everything here is invented (people, providers, streets); no customer data and no clock reads:
 * `receivedAt` is a literal string so a test's expectations never follow the wall clock (#304).
 *
 * Shape: posts → threads → comments. Every comment has a stable id that is also its permalink leaf
 * (`/c/<commentId>`), and a `parentId` when it replies to another comment in the same thread. The
 * inbox lists {@link SEED_COMMENTS} in ARRAY order, which is deliberately NOT id order: a test that
 * assumed "first row = lowest id" would pass by accident, so order can never stand in for identity.
 */

/** A reply identity ("Reply as"): the account a reply would be sent from. */
export interface BizopsIdentity {
  readonly id: string;
  readonly label: string;
}

/** The two seeded identities the workflow replies as (`mcpl` shared desk, `personal` persona). */
export const IDENTITIES: readonly BizopsIdentity[] = [
  { id: "mcpl", label: "McPlumb Support desk (fictional)" },
  { id: "personal", label: "Percy Persona (fictional)" },
];

export interface BizopsComment {
  /** Stable comment id; also this comment's permalink: `/c/<id>`. */
  readonly id: string;
  /** The comment this one replies to, or null for a thread's opening comment. */
  readonly parentId: string | null;
  /** Which identity's side of the conversation this comment belongs to. */
  readonly account: string;
  /** Fictional display name of whoever wrote it. */
  readonly author: string;
  /** Full text; may be multiline. */
  readonly text: string;
  /** Fictional arrival time, written down as a literal (never read from a clock). */
  readonly receivedAt: string;
}

export interface BizopsThread {
  readonly id: string;
  readonly title: string;
  readonly comments: readonly BizopsComment[];
}

export interface BizopsPost {
  readonly id: string;
  /** Where the conversation came in from (e.g. a fictional forum), surfaced as `data-provider`. */
  readonly provider: string;
  /** The transport on that provider (e.g. `forum`, `email`), surfaced as `data-channel`. */
  readonly channel: string;
  readonly title: string;
  readonly body: string;
  readonly threads: readonly BizopsThread[];
}

export const POSTS: readonly BizopsPost[] = [
  {
    id: "post-314",
    provider: "Mockcrew",
    channel: "forum",
    title: "Mockcrew Fictional Pier — paint schedule",
    body: "A thread from the fictional Mockcrew community about paint work on the Fictional Pier.",
    threads: [
      {
        id: "thread-31",
        title: "Late paint delivery",
        comments: [
          {
            id: "c-2041",
            parentId: null,
            account: "mcpl",
            author: "Marta Mallard (fictional)",
            text: "Hello Percy,\n\nThe Fictional Pier panels now arrive on Tuesday instead of Friday.\nCan the crew still start on the ninth?",
            receivedAt: "2024-02-05T09:12:00Z",
          },
          {
            id: "c-1007",
            parentId: "c-2041",
            account: "personal",
            author: "Percy Persona (fictional)",
            text: "Tuesday works, as long as the freight lift is booked for the ninth.",
            receivedAt: "2024-02-05T10:40:00Z",
          },
        ],
      },
      {
        id: "thread-32",
        title: "Ladder tags",
        comments: [
          {
            id: "c-3388",
            parentId: null,
            account: "mcpl",
            author: "Marta Mallard (fictional)",
            text: "Two ladder tags are missing from the store again.",
            receivedAt: "2024-02-06T07:05:00Z",
          },
          {
            id: "c-1210",
            parentId: "c-3388",
            account: "personal",
            author: "Percy Persona (fictional)",
            text: "Replacement tags sit in the locker by dock two.",
            receivedAt: "2024-02-06T08:22:00Z",
          },
        ],
      },
    ],
  },
  {
    id: "post-207",
    provider: "Bramble Yard",
    channel: "email",
    title: "Bramble Yard newsletter — community questions",
    body: "Answered questions from the fictional Bramble Yard newsletter.",
    threads: [
      {
        id: "thread-21",
        title: "Season pass question",
        comments: [
          {
            id: "c-4520",
            parentId: null,
            account: "personal",
            author: "Percy Persona (fictional)",
            text: "Does the season pass cover the Fictional Forge workshop?",
            receivedAt: "2024-02-07T13:30:00Z",
          },
          {
            id: "c-1462",
            parentId: "c-4520",
            account: "mcpl",
            author: "Marta Mallard (fictional)",
            text: "Yes — Forge sessions are included until the March break.",
            receivedAt: "2024-02-07T14:02:00Z",
          },
        ],
      },
      {
        id: "thread-22",
        title: "Parking on rehearsal nights",
        comments: [
          {
            id: "c-3391",
            parentId: null,
            account: "mcpl",
            author: "Marta Mallard (fictional)",
            text: "Where should visitors park on rehearsal nights?",
            receivedAt: "2024-02-08T17:45:00Z",
          },
          {
            id: "c-2014",
            parentId: "c-3391",
            account: "personal",
            author: "Percy Persona (fictional)",
            text: "Use the Fictional Yard overflow lot, gate B.",
            receivedAt: "2024-02-08T18:10:00Z",
          },
        ],
      },
    ],
  },
];

/** One seeded comment with the post and thread it lives in. */
export interface BizopsSeedComment {
  readonly post: BizopsPost;
  readonly thread: BizopsThread;
  readonly comment: BizopsComment;
}

/** Every seeded comment in seeded (NOT id) order: the inbox rows, and the ids a test expects. */
export const SEED_COMMENTS: readonly BizopsSeedComment[] = POSTS.flatMap((post) =>
  post.threads.flatMap((thread) => thread.comments.map((comment) => ({ post, thread, comment }))),
);

/** Comment id → its post/thread/comment, for `/c/<id>` and its reply endpoint. */
export const COMMENT_BY_ID: ReadonlyMap<string, BizopsSeedComment> = new Map(SEED_COMMENTS.map((seed) => [seed.comment.id, seed]));
