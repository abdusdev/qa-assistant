---
name: Shipments
components: []
labels:
  [
    needs-attention,
    rates,
    fedex,
    address-validation,
    address-classification,
    order-sync,
    order-history,
    shopify,
    printwise,
    regression,
  ]
keywords:
  [
    shipment,
    shipments,
    order,
    orders,
    label,
    labels,
    rate,
    rates,
    package,
    packages,
    tracking,
    bulk ship,
    packing slip,
    void,
    reprint,
    return shipment,
    clone,
    needs attention,
    ready to ship,
    address,
  ]
---

## What it is for

The main work screen. Sellers see their orders, create and edit shipments and packages, choose a carrier
rate, generate and print labels, and follow tracking.

## Screens and controls

- Shipments list: status tabs **Ready to Ship** (default), **Needs Attention**, **Partially Shipped**,
  **Shipped**, **To Process**, **Cancelled**, **Returned**, **All**. Ready to Ship, Shipped, Cancelled,
  Returned and All cannot be hidden. Users can reorder and hide the rest.
- Table columns: Order, Customer, Ship From, Title, Value, Dimensions, Rate, Shipping, Action.
- Search by order number or tracking number. Filters: status, tracking status, date range, marketplace,
  courier service, shipping speed, price range, multi-package, multi-shipment, PO Box, notes, package type.
  Filter chips can be cleared together, and a filter set can be saved.
- Bulk actions: bulk ship, bulk packing slips and export orders, each with a progress dialog.
- Buttons for a new shipment and a return shipment. Per shipment: clone, update, generate label, void,
  reprint, download PDF, packing slip.
- Shipment details has tabs: Ship From and Ship To forms with address autocomplete and validation, packages
  (create, update, clone, delete, bulk delete), items, and order logs (change history).

## Rules and limits

- Status comes from the order: cancelled orders are Cancelled. A shipped return is Returned. A shipped order
  is Shipped. An order with some shipped shipments is Partially Shipped. Anything else is Ready to Ship.
- Ready to Ship needs the order paid, not shipped, not cancelled, not partially shipped, and not Needs
  Attention.
- Needs Attention means an address classified as invalid, an address validation WARNING or ERROR, a PO Box,
  an order on hold, or a medium or high risk (or a recommendation to investigate or cancel). A tenant can add
  missing weight, missing dimensions, a missing address, or an order value over a threshold (default 500).
- A label can be generated as PDF or ZPL only. Amazon orders skip the remote shipped or cancelled check
  because the marketplace validates it.
- To Process is a shipped order with a tracking number still at Label Created. A tenant setting can skip it.
- Tracking status values: Label Created, Processed, Picked Up, In Transit, Delivered, Voided, Error, Unknown.
- Spelling: the tab says **Cancelled** and the status chip on a row says **Canceled**. The status chip
  labels are Ready to ship, Partially shipped, To Process, Reprint, Shipped, Canceled, Returned.
- A voided label scanned at the warehouse and a repeated scan are both recorded in the change history.

## Usual failures

- A business failure returns success false with HTTP 200. Only a malformed request returns 400.
- A rate fetch, label generation or shipment update can be in progress (internal statuses rates fetch in
  process, label generation in process, shipment update in process). Retrying must never buy a second label.
- Marketplace update errors are recorded on the shipment. A printing error gives the order the Reprint status.

_Source: ShipNest repository code (order service status filters, status hook, backend constants). A draft for
QA to review. Exact on-screen messages are not included and should be added by QA._
