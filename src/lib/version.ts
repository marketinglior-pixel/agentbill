// The commit this running image was built from.
//
// Two verification passes on 2026-09-07 had to record "the deployed image was
// built from commit X" as UNVERIFIED, and both were right to: /health said
// only {"status":"ok"}, /status named no version, the Fly image carries no
// labels, and no response header held a build id. Production could be checked
// for behaviour and never for provenance.
//
// It arrives as a Docker build argument rather than a file generated during the
// build, because the SHA is the one thing the build cannot derive for itself:
// the runtime image has no git binary and no history, and a generated file that
// had to be committed would be a second representation of the same fact.
//
// The shape is checked here so that nothing downstream has to escape it. It is
// rendered into an HTML page and a JSON body, and a build argument is an
// arbitrary string until someone constrains it.
const RAW = (process.env.GIT_SHA ?? '').trim()

/**
 * A short or full git SHA, or the literal "unknown".
 *
 * A "-dirty" suffix is part of the vocabulary: `npm run deploy --allow-dirty`
 * stamps one, because a deploy from an unclean tree is a real state and
 * erasing it would leave a marker that reads exactly like a trustworthy one.
 *
 * "unknown" is deliberate and it is visible on both surfaces. A deploy that
 * forgot the build argument says so, which is a smaller lie than a missing
 * field and a much smaller one than a stale value. `npm run deploy` always
 * passes it, and refuses to build from a dirty tree, because a SHA that names a
 * commit the image does not actually contain is worse than no SHA at all.
 */
export const COMMIT: string = /^[0-9a-f]{7,40}(-dirty)?$/.test(RAW) ? RAW : 'unknown'
