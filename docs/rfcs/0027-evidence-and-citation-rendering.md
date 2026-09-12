# RFC 0027: Evidence and citation rendering

- **Status:** Proposed
- **Phase:** Frontend (Phase 4 UI)
- **Date:** 2026-08
- **Author:** CodeCortex team
- **Affects:** `frontend/components/ChatThread.tsx` (extends RFC 0025/0026), new `frontend/components/EvidencePanel.tsx`
- **Depends on:** RFC 0019 (the evidence data this renders)

## Summary

Each answer's `evidence` array (RFC 0019) will be rendered as clickable, inspectable citations — inline markers within the answer's prose, or a collapsible "sources" panel beneath it — letting a user jump to and independently verify the exact file/line ranges backing each claim, rather than trusting the prose alone.

## Terminology

- **Inline citation:** a small marker (e.g., a superscript number) embedded within answer text, linking to a specific evidence item.
- **Sources panel:** a collapsible section beneath an answer listing every evidence item with its file path and line range.

## Motivation

RFC 0019 built the backend capability to expose verification evidence specifically so it could be shown to users — an unused backend field provides zero actual value. This RFC is what makes that capability real from a user's perspective.

## Detailed design

### Planned rendering approach

Given matching specific prose sentences to specific evidence items reliably is nontrivial (the Critic's claim wording and the final answer's prose aren't guaranteed to align token-for-token), this RFC starts with the simpler, more robust option: a **sources panel** beneath each answer (not inline markers within the prose), listing every evidence item as a clickable card showing the file path, line range, and the specific claim it supports.

```tsx
<EvidencePanel evidence={message.evidence}>
  {evidence.map(e => (
    <EvidenceCard
      key={e.filePath + e.startLine}
      claim={e.claim}
      filePath={e.filePath}
      lines={`${e.startLine}-${e.endLine}`}
      onClick={() => openFileAtLine(e.filePath, e.startLine)}
    />
  ))}
</EvidencePanel>
```

Inline citation markers (matching specific prose spans to evidence) are named as a future enhancement, not attempted in this initial version — see Open Questions.

### Planned "open file at line" behavior

Since this project has no in-app file browser yet, clicking an evidence card's initial implementation will link out to the file on GitHub at the specific commit/line range (`htmlUrl` + `/blob/{commitSha}/{filePath}#L{startLine}-L{endLine}`, GitHub's standard line-linking URL format) — simple, requires no new in-app file-viewing feature, and immediately useful.

## Implementation plan

1. Add `evidence` to the frontend's `ChatMessage` type in `lib/api.ts`, matching RFC 0019's backend shape.
2. Build `EvidencePanel`/`EvidenceCard` components.
3. Implement the GitHub deep-link behavior described above.
4. Manually verify: ask a real question, receive an answer with evidence, click through each evidence card, and confirm each correctly opens the right file at the right line range on GitHub.

## Alternatives considered

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A collapsible sources panel, GitHub deep-links** *(proposed)* | Simple, robust, requires no new in-app file-viewing capability | Less visually integrated than inline citations | **Proposed** |
| **Inline citation markers within the answer prose** | More polished, tighter claim-to-evidence linkage | Requires reliably matching specific prose spans to evidence items, which RFC 0015's claim extraction doesn't currently guarantee alignment for | Deferred — named as a future enhancement, not attempted now |
| **An in-app file viewer instead of linking out to GitHub** | Keeps the user inside the app | A meaningfully larger feature (rendering syntax-highlighted file content, handling large files) not justified by this RFC's narrower goal | Rejected for now |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Evidence line ranges are stale relative to the file's current state after a re-index (RFC 0018) | Medium over time | Low-medium | The GitHub deep-link includes the specific `commitSha` the evidence was verified against, so the link always shows the correct historical version, even if the file has since changed — this actually resolves RFC 0019's own flagged staleness concern cleanly |

## Security considerations

No new security surface — evidence data is already scoped/authorized correctly per RFC 0019's own design.

## Performance considerations

None of note — this is a straightforward rendering layer.

## Testing strategy

Manual click-through verification per Implementation Plan is this stage's checkpoint.

## Rollback plan

Straightforward — evidence rendering can be hidden without affecting the underlying answer content at all.

## Migration / rollout

None — new, additive UI.

## Consequences

**Positive:** turns RFC 0015/0019's verification guarantee into something concretely, immediately useful to a real user, and resolves RFC 0019's own staleness concern via commit-pinned deep links.

**Negative:** relies on linking out to GitHub rather than an in-app view — a reasonable initial scope, but a real UX limitation compared to a fuller in-app experience.

## Success criteria

Every evidence card, clicked, opens the correct file at the correct line range and commit on GitHub.

## Open questions

Should inline citation markers eventually be attempted, once/if claim-to-prose alignment becomes more reliable? Named, not solved here.

## Non-goals for this RFC

An in-app file viewer — explicitly deferred, per Alternatives.

## References

RFC 0019.
