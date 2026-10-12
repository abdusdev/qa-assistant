---
module: Shipments
---

## Create a shipment for a single order with a selected rate

- Type: ui
- Priority: high

Steps:

1. Open an order that has a Ship To address
2. Click "Fetch rates" and select one rate
3. Click "Ship"

Expected: A shipment is created with a tracking number and a label is available to print

## Order without a selected rate cannot be shipped in bulk

- Type: ui
- Priority: medium

Steps:

1. On the Orders page, tick one order that has a selected rate and one that has none
2. Click "Create shipments"

Expected: The "Shipment results" dialog shows one created shipment and one skipped order with the reason "No rate selected"

## Voided shipment cannot be reprinted

- Type: ui
- Priority: medium

Steps:

1. Open the shipment detail page of a voided shipment

Expected: The "Reprint label" button is not shown
