<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/5b7c7466-31a6-4e99-a67a-d95b64f95328

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`


## Shiprocket Integration

The admin Orders screen includes a **Shiprocket** button. It creates the selected store order in Shiprocket and saves the returned Shiprocket Order ID and Shipment ID back to the order. Shiprocket credentials are server-side only.

Before deployment, add these server environment variables/secrets:

- `SHIPROCKET_EMAIL` — the API user email created in Shiprocket.
- `SHIPROCKET_PASSWORD` — the API password shown once when the API user was created.
- `SHIPROCKET_PICKUP_LOCATION` — optional; if omitted, the server uses the first pickup location returned by Shiprocket.
- `SHIPROCKET_WEIGHT_KG`, `SHIPROCKET_LENGTH_CM`, `SHIPROCKET_BREADTH_CM`, `SHIPROCKET_HEIGHT_CM` — package defaults used for shipment creation.

For prepaid orders, the website requires the order's payment status to be **Paid** before creating the Shiprocket order. COD orders are sent as `COD`; confirmed prepaid orders are sent as `Prepaid`.

The integration uses Shiprocket's official Authentication API and order creation API. citeturn0search0turn0search1
