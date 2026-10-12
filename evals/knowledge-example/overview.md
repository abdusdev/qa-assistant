ShipNest (example) is a web platform that connects online stores with shipping couriers. A seller's
orders arrive from the store; the seller fetches a courier rate for each order, chooses one, and
ships. ShipNest creates the shipment with the courier, returns a tracking number and a label, and
keeps the store informed.

Main journey: an order arrives, the seller checks the Ship To address, fetches rates, selects a rate,
creates the shipment, prints the label, and the shipment is tracked until it is delivered.

Modules:

- Orders: the list of orders, with filters and bulk actions.
- Shipments: rates, shipment creation, labels, voiding and tracking.
- Automation rules: actions applied automatically to orders that match a condition.

Things that surprise new testers:

- A rate is only valid for the address it was fetched for. If the address changes, the rate is no
  longer valid.
- A voided shipment cannot be reprinted or shipped again.
