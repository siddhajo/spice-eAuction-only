# On-screen (inline) price editing — drawbacks & risks

**Request (Idukki note #8):** *"My dad feels lazy enough to change price via edit. He wants to
edit on-screen. Check will there be any drawbacks/risks."*

**Decision taken:** assess only — **not implemented** yet. This document is the assessment so
the change can be made with eyes open (or a safer alternative chosen).

---

## How price editing works today

- Price is changed only through the **Edit Lot modal** (`openLotEdit` → `l-price` → `saveLot`
  → `PUT /api/lots/:id`).
- The modal does three protective things automatically:
  - **Live amount recalc** — `amount = qty × price` updates as you type.
  - **Buyer auto-fill** — typing a buyer `code` fills buyer / sale fields.
  - **Withdrawn guard** — code `WD` forces price and amount to 0.
- On save, the server (`PUT /api/lots/:id`) also:
  - **Blocks locked lots** — returns `423` for non-admins when `flag_lot_lock` is on.
  - **Clears the price-check gate** (`pcClearGate`) and the lot-validation gate (`lvClearGate`)
    — any price change means the trade must be re-verified before invoices/purchases can be
    generated (when `flag_price_check` / `flag_lot_validation` are on).
  - **Logs a field-level A→B diff** to the activity log.
- **Important:** a price change updates `amount` only. **Commission, GST, TDS and payable are
  NOT recalculated automatically** — the operator must run **Calculate All** afterwards. The
  modal at least surfaces this as a nudge.

So the modal is slow, but every guard rail lives around it.

---

## Risks of making the price cell editable inline in the Lots table

1. **Stale derived figures.** Inline edit that only PUTs `price` leaves commission, GST, payable
   and bill amount stale until *Calculate All* is run. Across many quick edits it is very easy to
   forget — the row *looks* done because `amount` updated.

2. **Silent price-check invalidation.** Every price edit clears the price-check stamp. Editing a
   price *after* the sheet was verified silently re-opens the gate. In the modal the operator is
   in a deliberate context; inline, they may not realise verification was undone. If
   `flag_price_check` is **off**, nothing stops an invoice being generated against an unverified
   price.

3. **Fat-finger / accidental edits.** A grid full of editable cells is one stray click, Tab or
   touch-scroll away from silently changing a **financially sensitive** number, with no
   confirmation. The modal is a deliberate, focused action; inline removes that friction.

4. **Withdrawn (WD) mismatch.** The server forces price = 0 for `WD` lots. A price typed inline on
   a WD lot is silently zeroed server-side, but the cell still shows the typed value until a
   refresh — a confusing UI-vs-stored divergence.

5. **Locked-lot divergence.** The server rejects edits to locked lots (`423`). Inline UI must
   catch that and **revert the cell**, or the shown value drifts from what's stored.

6. **Already-invoiced lots.** If a lot is already on a generated invoice/purchase, changing its
   price inline (without reverting the document) desyncs the lot from the issued paperwork. The
   modal has the same exposure but is used more deliberately; a fast inline path makes it far
   easier to do by accident.

7. **Concurrency.** Two operators editing the lots table at once → last-write-wins with no
   collision signal. The modal's slower cadence naturally reduces this.

8. **Input validation.** The modal uses a numeric `step` input. Inline cells must replicate
   sanitisation (numeric only, non-negative, sane upper bound) or garbage prices can be saved.

---

## Verdict

Inline price editing is **technically feasible** — the server PUT already enforces the hard
safety rules (lock `423`, WD zeroing, gate clearing, audit logging), so the **data stays safe**.
The real cost is **operational**: it removes the deliberate, one-lot-at-a-time friction and the
recalc/re-verify nudge that stop stale totals and unverified invoices.

## Recommended safer middle ground

Rather than making *every* cell in the main Lots table editable, add a dedicated **price-only
entry grid** — the lots listed with just the **Price** column editable (keyboard-friendly,
Enter = next row), then a single **Calculate All** + **re-verify** step at the end. This gives
the "no modal, type fast" speed the request is really after, without the accidental-edit and
stale-total risks of a fully editable table.

If full inline editing *is* still wanted, implement it with these guards:

- After each inline save, **auto-run per-lot recalc** (or flag the row "needs Calculate" with a
  visible badge) and show the price-check **re-verify** banner.
- **Confirm-on-blur** (before→after) like the existing masters `contenteditable` pattern —
  not a silent save.
- **Fall back to the modal** (with an explanation) when the lot is locked, `code = WD`, or
  already tied to a generated invoice/purchase.
- **Sanitise** input (numeric, ≥ 0, upper bound) and **revert the cell** on any server rejection.
