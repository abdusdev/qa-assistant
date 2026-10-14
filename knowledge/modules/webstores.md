---
name: Webstores and marketplace integrations
components: []
labels: [order-sync, shopify, amazon, ebay, walmart, newegg, bestbuy]
keywords:
  [
    webstore,
    webstores,
    marketplace,
    marketplaces,
    amazon,
    sp-api,
    ebay,
    shopify,
    walmart,
    newegg,
    best buy,
    bestbuy,
    woocommerce,
    temu,
    oauth,
    order sync,
    sync orders,
    import orders,
    courier preference,
  ]
---

## What it is for

Connects a seller's online stores to ShipNest so their orders are imported, and so shipped status and tracking
go back to the marketplace.

## Screens and controls

- Webstore Settings (under Configurations): a table of connected webstores with an active or inactive switch
  and a menu to edit or delete.
- Add webstore wizard (a drawer, three steps): **Webstore Selection**, then **Dynamic Form** with the
  platform's own credential fields, then **Summary** to review and confirm.
- Edit webstore: an **Account information** tab and a **Shipping Accounts** tab, where courier preferences
  are created and deleted per webstore.
- Shipments list: a marketplace sync for one webstore, a sync-all, and a sync progress indicator. Marketplace
  is also a filter on the list.
- Supported in the wizard: Amazon, Shopify and eBay (these connect through an OAuth redirect), and Walmart,
  Newegg, Newegg Business and Best Buy (credentials). WooCommerce and Temu exist in the backend.

## Rules and limits

- An order number is unique within one webstore. Importing or posting the same number again is a conflict,
  not a duplicate order.
- Orders are imported by scheduled jobs, webhooks, or a manual sync. A webstore shows a fetching-orders state
  while a sync runs.
- For Shopify, an older marketplace snapshot must not overwrite a newer cancellation, address or payment
  state. The marketplace's own updated time decides.
- OAuth connections use a generated state value that is checked when the marketplace redirects back.
- Amazon validates shipped and cancelled status itself when a label is created.
- Only the courier preferences set for a webstore are offered for its orders.
- Deleting a webstore or turning it off must stop its orders from being imported.

## Usual failures

- A marketplace API can be rate limited or unavailable. A partial sync must report what was imported and
  what failed, without losing the orders already saved.
- A failed OAuth redirect (declined access, wrong state) must leave no half-connected webstore.
- Sending shipped status back to the marketplace can fail after the label is bought. The failure is
  recorded on the shipment.

_Source: ShipNest repository (features document, marketplace adapters, constants, order service). A draft for
QA to review. Exact credential field names and messages per platform are not included._
