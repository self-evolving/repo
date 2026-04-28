import type { GraphQLClient } from "./github-graphql.js";

/**
 * Summary metadata for the discussion body shown at the top of the transcript.
 */
export interface DiscussionTranscriptMeta {
  id: string;
  title: string;
  url: string;
  body: string;
  author: string;
}

/**
 * A reply entry in the discussion transcript.
 */
export interface DiscussionTranscriptReply {
  id: string;
  body: string;
  createdAt: string;
  author: string;
  replyToId: string;
}

/**
 * A top-level discussion comment with any nested replies.
 */
export interface DiscussionTranscriptComment extends DiscussionTranscriptReply {
  replies: DiscussionTranscriptReply[];
}

/**
 * Fetches one page of discussion comments and the first page of replies.
 */
function fetchDiscussionPage(
  github: GraphQLClient,
  owner: string,
  repo: string,
  number: number,
  after?: string,
): DiscussionPagePayload {
  return github.graphql<DiscussionPagePayload>(
    `
      query($owner: String!, $repo: String!, $number: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          discussion(number: $number) {
            id
            title
            url
            body
            author {
              login
            }
            comments(first: 100, after: $after) {
              nodes {
                id
                body
                createdAt
                author {
                  login
                }
                replyTo {
                  id
                }
                replies(first: 100) {
                  nodes {
                    id
                    body
                    createdAt
                    author {
                      login
                    }
                    replyTo {
                      id
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `,
    { owner, repo, number, after },
  );
}

/**
 * Fetches an additional page of replies for a single discussion comment.
 */
function fetchReplyPage(
  github: GraphQLClient,
  commentId: string,
  after?: string,
): ReplyPagePayload {
  return github.graphql<ReplyPagePayload>(
    `
      query($commentId: ID!, $after: String) {
        node(id: $commentId) {
          ... on DiscussionComment {
            replies(first: 100, after: $after) {
              nodes {
                id
                body
                createdAt
                author {
                  login
                }
                replyTo {
                  id
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `,
    { commentId, after },
  );
}

interface DiscussionPagePayload {
  repository?: {
    discussion?: {
      id?: string;
      title?: string;
      url?: string;
      body?: string;
      author?: { login?: string | null } | null;
      comments?: {
        nodes?: Array<{
          id: string;
          body?: string | null;
          createdAt?: string | null;
          author?: { login?: string | null } | null;
          replyTo?: { id?: string | null } | null;
          replies?: {
            nodes?: Array<{
              id: string;
              body?: string | null;
              createdAt?: string | null;
              author?: { login?: string | null } | null;
              replyTo?: { id?: string | null } | null;
            }>;
            pageInfo?: {
              hasNextPage?: boolean | null;
              endCursor?: string | null;
            } | null;
          } | null;
        }>;
        pageInfo?: {
          hasNextPage?: boolean | null;
          endCursor?: string | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

interface ReplyPagePayload {
  node?: {
    replies?: {
      nodes?: Array<{
        id: string;
        body?: string | null;
        createdAt?: string | null;
        author?: { login?: string | null } | null;
        replyTo?: { id?: string | null } | null;
      }>;
      pageInfo?: {
        hasNextPage?: boolean | null;
        endCursor?: string | null;
      } | null;
    } | null;
  } | null;
}

function normalizeReply(reply: {
  id: string;
  body?: string | null;
  createdAt?: string | null;
  author?: { login?: string | null } | null;
  replyTo?: { id?: string | null } | null;
}): DiscussionTranscriptReply {
  return {
    id: reply.id,
    body: reply.body || "",
    createdAt: reply.createdAt || "",
    author: reply.author?.login || "ghost",
    replyToId: reply.replyTo?.id || "",
  };
}

/**
 * Fetches the full discussion transcript, including paginated comments and replies.
 */
export function fetchDiscussionTranscript(
  github: GraphQLClient,
  owner: string,
  repo: string,
  number: number,
): {
  discussionMeta: DiscussionTranscriptMeta;
  comments: DiscussionTranscriptComment[];
} {
  let discussionMeta: DiscussionTranscriptMeta | null = null;
  const comments: DiscussionTranscriptComment[] = [];
  let after: string | undefined;
  let hasNextPage = true;

  while (hasNextPage) {
    const page = fetchDiscussionPage(github, owner, repo, number, after);
    const discussion = page.repository?.discussion;
    if (!discussion) {
      throw new Error(`Discussion #${number} not found`);
    }

    if (!discussionMeta) {
      discussionMeta = {
        id: discussion.id || "",
        title: discussion.title || "",
        url: discussion.url || "",
        body: discussion.body || "",
        author: discussion.author?.login || "ghost",
      };
    }

    for (const rawComment of discussion.comments?.nodes || []) {
      const replies = (rawComment.replies?.nodes || []).map(normalizeReply);
      let replyAfter = rawComment.replies?.pageInfo?.endCursor || undefined;
      let replyHasNextPage = rawComment.replies?.pageInfo?.hasNextPage || false;

      while (replyHasNextPage) {
        const replyPage = fetchReplyPage(github, rawComment.id, replyAfter);
        const moreReplies = replyPage.node?.replies;
        if (!moreReplies) {
          break;
        }

        replies.push(...(moreReplies.nodes || []).map(normalizeReply));
        replyAfter = moreReplies.pageInfo?.endCursor || undefined;
        replyHasNextPage = moreReplies.pageInfo?.hasNextPage || false;
      }

      comments.push({
        ...normalizeReply(rawComment),
        replies,
      });
    }

    after = discussion.comments?.pageInfo?.endCursor || undefined;
    hasNextPage = discussion.comments?.pageInfo?.hasNextPage || false;
  }

  return {
    discussionMeta: discussionMeta || {
      id: "",
      title: "",
      url: "",
      body: "",
      author: "ghost",
    },
    comments,
  };
}

/**
 * Builds the markdown transcript consumed by the agent prompt.
 */
export function buildDiscussionTranscript(
  discussionMeta: DiscussionTranscriptMeta,
  comments: DiscussionTranscriptComment[],
): string {
  let transcript = "# Discussion\n\n";
  transcript += `Title: ${discussionMeta.title}\n`;
  transcript += `URL: ${discussionMeta.url}\n`;
  transcript += `Author: ${discussionMeta.author}\n\n`;
  transcript += `## Body\n${discussionMeta.body}\n\n`;
  transcript += "## Comments\n\n";

  if (comments.length === 0) {
    transcript += "_No comments yet._\n";
    return transcript;
  }

  for (const comment of comments) {
    transcript += formatDiscussionTranscriptComment(comment, 0);
    transcript += "\n";
    for (const reply of comment.replies) {
      transcript += formatDiscussionTranscriptComment(reply, 1);
      transcript += "\n";
    }
  }

  return transcript;
}

/**
 * Formats a top-level comment or nested reply for the transcript body.
 */
export function formatDiscussionTranscriptComment(
  comment: DiscussionTranscriptReply,
  depth: number,
): string {
  const heading = depth === 0 ? "### Comment" : "#### Reply";
  const author = comment.author || "ghost";
  const createdAt = comment.createdAt || "";
  return `${heading} by ${author} at ${createdAt}\n${comment.body || ""}\n`;
}
