# ShipNest overview

ShipNest is a multi-carrier, multi-marketplace shipping and order management platform, built by Ninety Nine
Technologies. Sellers connect their online stores and carrier accounts, and ShipNest brings every order into
one place where they create shipments, buy labels, print them and follow tracking.

**Who uses it.** Three roles: Admin, User and Warehouse. Admin and User see everything (Shipments,
Configurations, Scan Labels). Warehouse sees only the operations screens (Scan Labels). Every account is a
separate tenant: one seller must never see another seller's orders, labels or settings.

**Main journey.** Order ingestion, then shipment creation, then rates and label generation, then printing,
then tracking.

1. Marketplace orders arrive from the connected webstores (scheduled imports, webhooks or a manual sync).
2. An order becomes one or more shipments, each with one or more packages.
3. A carrier rate is chosen (rate shopping) and a label is generated, as PDF or ZPL.
4. The label is printed or downloaded, and the order is marked shipped in the marketplace.
5. Carrier tracking updates the package's tracking status until it is delivered.

**Systems it connects to.**

- Marketplaces (webstores): Amazon, eBay, Shopify, Walmart, Newegg, Newegg Business, Best Buy, and also
  WooCommerce and Temu in the backend.
- Carriers: FedEx, UPS and USPS (also Amazon shipping for tracking).
- A PII vault holds addresses and contact details apart from the main database.
- Printing: the ShipNest Toolbox desktop app prints locally on Windows, and a Printwise integration queues
  print jobs.

**Main areas.** Shipments (orders, shipments, packages, labels), Configurations (carrier accounts, webstores,
printing templates), and Scan Labels. The app also has automation rules, tags, custom packages, reports and
Printwise screens.

**Surprises for new testers.**

- A failed business action often returns HTTP 200 with `success: false`, not an error code. Only a malformed
  request returns 400.
- A label is paid for. Repeating a generate action must never buy a second label.
- Order numbers are unique per marketplace: posting the same order number to the same webstore is a conflict.
- ShipNest is invite-only. There is no public sign-up.

_Source: the ShipNest repository (`CLAUDE.md`, `ShipNest-Website-Features.md`, backend constants). A draft for
QA to review and correct._
