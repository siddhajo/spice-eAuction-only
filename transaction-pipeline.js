// ── TRANSACTION PIPELINE ─────────────────────────────────────
// The order a trade's numbered documents are raised in, and what each step
// needs from the operator before it can run.
//
// This file is DESCRIPTION ONLY — no SQL, no generation logic. Every step
// points at a route that already exists and is unchanged. It exists so one
// screen (the one-click "generate everything for this trade" flow on Price
// Entry) can drive all five modules without hard-coding their labels, flags,
// number fields and ordering, the same way document-catalog.js lets the Trade
// Desk render the document surface without hard-coding 67 tiles.
//
// ── WHY ORDER MATTERS ────────────────────────────────────────
// This is not a flat fan-out. Two of the five consume rows the other three
// write:
//
//     invoices ─┐
//     purchases ─┬─→ debit_notes          (reads `purchases`)
//     bills ─────┴─→ debit_notes_planter  (reads `bills`, seller-wise)
//
// So `after` is load-bearing: a debit-note step run before its source exists
// finds nothing to do and silently reports success. A runner must honour it,
// and a step whose dependency failed must be reported BLOCKED rather than
// skipped — "0 created" and "could not be attempted" are different answers,
// and only one of them means the operator still owes the trade a document.
//
// ── ENTRY SHAPE ──────────────────────────────────────────────
//   id          stable key; also the key in /api/auctions/:id/transaction-plan
//   label       operator-facing name
//   series      which doc-numbering.js series hands out this step's numbers.
//               NOT the same thing as `id`: the scopes differ wildly (global
//               per sale type / global across trades / per trade), which is
//               exactly why numbering lives in that registry and not here.
//   statusKey   key into /api/auctions/:id/generation-status, so the plan and
//               the existing per-tab "all done" gate agree on what is done
//   deepLink    sidebar tab that owns this document's own generation screen
//   numberField the body field its generate route reads the start number from
//               — three different spellings across five modules, which is one
//               more reason a caller should not be writing them by hand
//   keyedBy     'auctionId' → route takes /:auctionId; 'ano' → body { ano }
//   flag        install flag that must be true for the step to exist at all.
//               null = always available.
//   after       step ids whose documents this one reads
//   route       POST route that runs the step

'use strict';

const PIPELINE = [
  {
    id: 'invoices', label: 'Sales Invoices',
    series: 'invoices', statusKey: 'invoices', deepLink: 'invoices',
    numberField: 'startInvoiceNo', keyedBy: 'auctionId',
    flag: null, after: [],
    route: '/api/invoices/generate-all/:auctionId',
  },
  {
    id: 'purchases', label: 'Purchase Invoices',
    series: 'purchases', statusKey: 'purchases', deepLink: 'purchases',
    numberField: 'startInvoiceNo', keyedBy: 'auctionId',
    flag: null, after: [],
    route: '/api/purchases/generate-all/:auctionId',
  },
  {
    id: 'bills', label: 'Bills of Supply',
    series: 'bills', statusKey: 'bills', deepLink: 'bills',
    numberField: 'startBillNo', keyedBy: 'auctionId',
    flag: null, after: [],
    route: '/api/bills/generate-all/:auctionId',
  },
  {
    id: 'debit_notes', label: 'Debit Notes (Service)',
    series: 'debit_notes', statusKey: 'debit_notes', deepLink: 'debit',
    numberField: 'startNoteNo', keyedBy: 'ano',
    flag: 'flag_debit_note', after: ['purchases'],
    route: '/api/debit-notes/generate-bulk',
  },
  {
    id: 'debit_notes_planter', label: 'Debit Notes — Planter',
    series: 'debit_notes_planter', statusKey: 'debit_notes_planter', deepLink: 'debitplanter',
    numberField: 'startNoteNo', keyedBy: 'ano',
    flag: 'flag_debit_note_planter', after: ['bills'],
    route: '/api/debit-notes-planter/generate-bulk',
  },
];

const BY_ID = Object.fromEntries(PIPELINE.map(s => [s.id, s]));

module.exports = { PIPELINE, BY_ID };
