---
name: Shipments
components: [Shipments]
labels: [shipments, rates, labels, regression]
keywords: [shipment, shipments, rate, rates, label, tracking, courier, ship to, bulk]
---

Sellers ship orders from the Orders page (several at once) or from an order's detail page (one).

## Screens and controls

- Orders page: tick orders with the row checkboxes, then use the "Create shipments" button. The
  button is disabled while no order is ticked.
- Order detail page: "Fetch rates" gets rates for the order's current Ship To address. Pick one
  rate, then use "Ship".
- After a bulk action the "Shipment results" dialog opens. It lists every selected order with a
  result column and, for skipped or failed orders, a reason column. Its "Retry failed" button
  retries only the failed orders.
- Shipment detail page: the "Reprint label" and "Void shipment" buttons.

## Rules and limits

- A bulk action accepts at most 100 orders. With 101 or more, the message "You can create shipments
  for up to 100 orders at a time" is shown and nothing is created.
- Each order uses its own selected rate. An order without a selected rate is skipped, with the
  reason "No rate selected".
- An order with an invalid Ship To address is skipped, with the reason "Invalid Ship To address".
- When the Ship To address changes, fetched rates become outdated and "Ship" stays disabled until
  new rates are fetched. The warning is "The destination changed. Please fetch new rates before
  shipping this order."
- "Reprint label" is shown only to users with the Shipments permission, and not for voided or
  delivered shipments. It keeps the tracking number and creates no new charge.

## Usual failures

- Courier outage: no shipment is created for the affected orders. They appear in the "Shipment
  results" dialog with the reason "Courier did not respond" and can be retried with "Retry failed".
- Partial success is normal: the dialog shows how many shipments were created, skipped and failed.
