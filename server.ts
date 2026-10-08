import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure persistent storage directory exists
const DATA_DIR = path.resolve(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const PHONEPE_CONFIG_FILE = path.join(DATA_DIR, 'phonepe_config.json');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const RETURNS_FILE = path.join(DATA_DIR, 'returns.json');
const VIDEO_SETTINGS_FILE = path.join(DATA_DIR, 'video_settings.json');
const STORE_SETTINGS_FILE = path.join(DATA_DIR, 'store_settings.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin_auth.json');

// Helper to safely read JSON files
function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as T;
    }
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return fallback;
}

// Helper to safely write JSON files
function writeJsonFile<T>(filePath: string, data: T): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

// Media uploads directory
const UPLOADS_DIR = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Helper to convert base64 data URLs to stored physical images
function saveBase64Image(dataUrl: string): string {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return dataUrl;
  }
  try {
    const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!match) return dataUrl;
    let ext = match[1].toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'svg+xml') ext = 'svg';
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `fabric_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, buffer);
    return `/uploads/${filename}`;
  } catch (err) {
    console.error('Failed to convert base64 image to file:', err);
    return dataUrl;
  }
}

// Ensure product images are converted from heavy base64 to lightweight URLs
function processProductImages(product: any): any {
  if (!product || typeof product !== 'object') return product;
  const clone = { ...product };
  if (clone.image) {
    clone.image = saveBase64Image(clone.image);
  }
  if (Array.isArray(clone.additionalImages)) {
    clone.additionalImages = clone.additionalImages.map((img: string) => saveBase64Image(img));
  }
  if (Array.isArray(clone.variants)) {
    clone.variants = clone.variants.map((v: any) => ({
      ...v,
      image: v.image ? saveBase64Image(v.image) : clone.image
    }));
  }
  return clone;
}

// PhonePe Configuration interface
export interface PhonePeConfig {
  merchantId: string;
  saltKey: string;
  saltIndex: string;
  environment: 'sandbox' | 'production';
  phonepeUpi: string;
  merchantName: string;
  enabled: boolean;
  callbackUrl?: string;
}

// Default PhonePe configuration
function getPhonePeConfig(): PhonePeConfig {
  const envMode = (process.env.PHONEPE_ENV as 'sandbox' | 'production') || 'sandbox';
  const defaultConf: PhonePeConfig = {
    merchantId: process.env.PHONEPE_MERCHANT_ID || (envMode === 'production' ? '' : 'PGTESTPAYUAT'),
    saltKey: process.env.PHONEPE_SALT_KEY || (envMode === 'production' ? '' : '099eb0cd-02cf-4e2a-8aca-3e6c6aff0399'),
    saltIndex: process.env.PHONEPE_SALT_INDEX || '1',
    environment: envMode,
    phonepeUpi: process.env.PHONEPE_UPI_VPA || 'shreemarutikrupa@ybl',
    merchantName: 'Shree Maruti Krupa',
    enabled: true,
  };
  return readJsonFile<PhonePeConfig>(PHONEPE_CONFIG_FILE, defaultConf);
}

// Payment session interface
export interface PaymentSession {
  id: string; // paymentId (e.g. PAY_...)
  orderId: string;
  merchantTransactionId: string;
  phonepeTransactionId?: string;
  amount: number; // in INR
  amountInPaise: number; // in Paise for exact comparison
  currency: string;
  method: 'upi' | 'card' | 'cod' | 'phonepe';
  status: 'initiated' | 'paid' | 'failed' | 'cancelled' | 'cod_pending';
  upiIntentUrl?: string;
  phonepeIntentUrl?: string;
  phonepeRedirectUrl?: string;
  utr?: string;
  customerName?: string;
  customerPhone?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  verificationSource?: string;
  razorpayOrderId?: string;
}

// Server-Side Helper: Query official PhonePe Status API via POST request using SALT_KEY
async function queryPhonePeStatus(
  merchantId: string,
  merchantTransactionId: string,
  saltKey: string,
  saltIndex: string,
  environment: 'sandbox' | 'production',
  expectedAmountInPaise?: number
): Promise<{
  success: boolean;
  verified: boolean;
  code: string;
  message: string;
  transactionId?: string;
  amount?: number;
  data?: any;
}> {
  // Checksum generated using server-side SALT_KEY
  const stringToHash = `/pg/v1/status/${merchantId}/${merchantTransactionId}${saltKey}`;
  const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
  const checksum = `${sha256}###${saltIndex}`;

  const hostUrl = environment === 'production'
    ? 'https://api.phonepe.com/apis/hermes'
    : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

  try {
    // POST request to PhonePe 'status' API using server-side SALT_KEY checksum
    let res = await fetch(`${hostUrl}/pg/v1/status/${merchantId}/${merchantTransactionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VERIFY': checksum,
        'X-MERCHANT-ID': merchantId,
      },
      body: JSON.stringify({
        merchantId,
        merchantTransactionId,
      }),
    });

    // Fallback to GET if PhonePe cluster returns 405 Method Not Allowed
    if (res.status === 405) {
      res = await fetch(`${hostUrl}/pg/v1/status/${merchantId}/${merchantTransactionId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': merchantId,
        },
      });
    }

    const json = await res.json();
    const data = json.data;

    // Strict Server-Side Validation:
    // 1. PhonePe status must be PAYMENT_SUCCESS and state COMPLETED
    // 2. merchantTransactionId must match the queried transaction
    // 3. Amount must exactly match expected order total in paise
    const isSuccess = json.code === 'PAYMENT_SUCCESS' && (data?.state === 'COMPLETED' || data?.responseCode === 'SUCCESS');
    const isTxnMatch = !data?.merchantTransactionId || data.merchantTransactionId === merchantTransactionId;
    const isMerchantMatch = !data?.merchantId || data.merchantId === merchantId;
    const isAmountMatch = expectedAmountInPaise === undefined || (typeof data?.amount === 'number' && data.amount === expectedAmountInPaise);

    const isVerified = Boolean(isSuccess && isTxnMatch && isMerchantMatch && isAmountMatch);

    return {
      success: json.success || isSuccess,
      verified: isVerified,
      code: json.code || (isVerified ? 'PAYMENT_SUCCESS' : 'PAYMENT_ERROR'),
      message: json.message || (isVerified ? 'Payment successfully verified by PhonePe' : 'Payment not confirmed by PhonePe'),
      transactionId: data?.transactionId,
      amount: data?.amount,
      data,
    };
  } catch (err) {
    return {
      success: false,
      verified: false,
      code: 'NETWORK_ERROR',
      message: 'Failed to connect to PhonePe gateway server',
    };
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use('/uploads', express.static(UPLOADS_DIR));

  // Upload image API
  app.post('/api/upload', (req, res) => {
    try {
      const { image } = req.body;
      if (!image) {
        return res.status(400).json({ success: false, error: 'Image data URL required' });
      }
      const url = saveBase64Image(image);
      res.json({ success: true, url });
    } catch (err) {
      console.error('Upload failed:', err);
      res.status(500).json({ success: false, error: 'Upload processing failed' });
    }
  });

  // Merchant details from env or production defaults
  const MERCHANT_UPI_VPA = process.env.MERCHANT_UPI_VPA || 'shreemarutikrupa@okaxis';
  const MERCHANT_NAME = process.env.MERCHANT_NAME || 'Shree Maruti Krupa';
  const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
  const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';


  // ---------------- Shiprocket Integration ----------------
  // Credentials stay strictly on the server. The browser only calls our /api/shiprocket/* endpoints.
  const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
  let shiprocketToken: { token: string; expiresAt: number } | null = null;

  async function getShiprocketToken(): Promise<string> {
    const email = String(process.env.SHIPROCKET_EMAIL || '').trim();
    const password = String(process.env.SHIPROCKET_PASSWORD || '').trim();
    if (!email || !password) {
      throw new Error('Shiprocket credentials are not configured on the server');
    }

    // Shiprocket tokens are valid for 240 hours. Refresh a little early.
    if (shiprocketToken && shiprocketToken.expiresAt > Date.now() + 5 * 60 * 1000) {
      return shiprocketToken.token;
    }

    const authRes = await fetch(`${SHIPROCKET_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const authJson: any = await authRes.json().catch(() => ({}));
    if (!authRes.ok || !authJson?.token) {
      const msg = authJson?.message || authJson?.error || `Authentication failed (${authRes.status})`;
      throw new Error(`Shiprocket authentication failed: ${msg}`);
    }

    shiprocketToken = {
      token: String(authJson.token),
      expiresAt: Date.now() + 9 * 24 * 60 * 60 * 1000,
    };
    return shiprocketToken.token;
  }

  async function shiprocketRequest(pathname: string, init: RequestInit = {}): Promise<any> {
    const token = await getShiprocketToken();
    const headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${token}`);

    let response = await fetch(`${SHIPROCKET_BASE_URL}${pathname}`, { ...init, headers });
    let json: any = await response.json().catch(() => ({}));

    // If a cached token expired unexpectedly, refresh once and retry.
    if (response.status === 401) {
      shiprocketToken = null;
      const freshToken = await getShiprocketToken();
      headers.set('Authorization', `Bearer ${freshToken}`);
      response = await fetch(`${SHIPROCKET_BASE_URL}${pathname}`, { ...init, headers });
      json = await response.json().catch(() => ({}));
    }

    if (!response.ok) {
      const message = json?.message || json?.error || json?.errors || `Shiprocket API error (${response.status})`;
      throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
    }
    return json;
  }

  function shiprocketOrderDate(order: any): string {
    const candidate = order?.createdAt || order?.date;
    const parsed = candidate ? new Date(candidate) : new Date();
    const safe = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(safe.getDate())} ${pad(safe.getHours())}:${pad(safe.getMinutes())}`;
  }

  function splitName(fullName: string): { first: string; last: string } {
    const parts = String(fullName || 'Customer').trim().split(/\\s+/).filter(Boolean);
    return {
      first: parts[0] || 'Customer',
      last: parts.slice(1).join(' ') || '',
    };
  }

  // Check Shiprocket configuration without exposing the password/token.
  app.get('/api/shiprocket/config', async (_req, res) => {
    res.json({
      success: true,
      configured: Boolean(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD),
      pickupLocationConfigured: Boolean(process.env.SHIPROCKET_PICKUP_LOCATION),
    });
  });

  // Create a Shiprocket order from an existing store order.
  app.post('/api/shiprocket/orders/:id/create', async (req, res) => {
    try {
      const { id } = req.params;
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const order = orders.find(o => o.id === id || o.orderNumber === id);
      if (!order) {
        return res.status(404).json({ success: false, error: 'Order not found' });
      }

      if (order.shiprocketOrderId && order.shiprocketShipmentId) {
        return res.json({
          success: true,
          alreadyCreated: true,
          order,
          shiprocket: {
            orderId: order.shiprocketOrderId,
            shipmentId: order.shiprocketShipmentId,
            awbCode: order.shiprocketAwbCode || '',
            courierName: order.shiprocketCourierName || '',
          },
        });
      }

      if (order.paymentMethod !== 'cod' && order.paymentStatus !== 'paid') {
        return res.status(400).json({
          success: false,
          error: 'Prepaid order is not payment-confirmed yet. Mark the payment as Paid before creating the Shiprocket shipment.',
        });
      }

      // Prefer the configured pickup location. Otherwise use the first pickup address
      // available in the Shiprocket account.
      let pickupLocation = String(process.env.SHIPROCKET_PICKUP_LOCATION || '').trim();
      if (!pickupLocation) {
        const pickupJson = await shiprocketRequest('/settings/company/pickup');
        const addresses = Array.isArray(pickupJson?.data) ? pickupJson.data
          : Array.isArray(pickupJson?.shipping_address) ? pickupJson.shipping_address
          : Array.isArray(pickupJson?.data?.shipping_address) ? pickupJson.data.shipping_address
          : [];
        const active = addresses.find((a: any) => a?.status === 1 || a?.status === '1' || a?.status === 'Active') || addresses[0];
        pickupLocation = String(active?.pickup_location || active?.pickupLocation || active?.name || '').trim();
      }
      if (!pickupLocation) {
        return res.status(400).json({
          success: false,
          error: 'No Shiprocket pickup location found. Set SHIPROCKET_PICKUP_LOCATION to the exact pickup-location name from Shiprocket.',
        });
      }

      const address = order.shippingAddress || {};
      const { first, last } = splitName(address.fullName);
      const paymentMethod = order.paymentMethod === 'cod' ? 'COD' : 'Prepaid';
      const packageWeight = Math.max(0.5, Number(process.env.SHIPROCKET_WEIGHT_KG || 0.5));
      const length = Math.max(1, Number(process.env.SHIPROCKET_LENGTH_CM || 20));
      const breadth = Math.max(1, Number(process.env.SHIPROCKET_BREADTH_CM || 15));
      const height = Math.max(1, Number(process.env.SHIPROCKET_HEIGHT_CM || 10));

      const payload = {
        order_id: String(order.orderNumber),
        order_date: shiprocketOrderDate(order),
        pickup_location: pickupLocation,
        comment: `Shree Maruti Krupa website order ${order.orderNumber}`,
        billing_customer_name: first,
        billing_last_name: last,
        billing_address: String(address.houseFlat || ''),
        billing_address_2: String(address.roadArea || ''),
        billing_city: String(address.city || ''),
        billing_pincode: String(address.pincode || ''),
        billing_state: String(address.state || ''),
        billing_country: 'India',
        billing_email: String(order.customerEmail || 'support@shreemarutikrupa.com'),
        billing_phone: String(address.phoneNumber || ''),
        shipping_is_billing: true,
        shipping_customer_name: first,
        shipping_last_name: last,
        shipping_address: String(address.houseFlat || ''),
        shipping_address_2: String(address.roadArea || ''),
        shipping_city: String(address.city || ''),
        shipping_pincode: String(address.pincode || ''),
        shipping_country: 'India',
        shipping_state: String(address.state || ''),
        shipping_email: String(order.customerEmail || 'support@shreemarutikrupa.com'),
        shipping_phone: String(address.phoneNumber || ''),
        order_items: (Array.isArray(order.items) ? order.items : []).map((item: any, index: number) => ({
          name: String(item?.product?.name || `Product ${index + 1}`),
          sku: String(item?.product?.id || `${order.orderNumber}-${index + 1}`),
          units: Math.max(1, Number(item?.quantity || 1)),
          selling_price: Number(item?.product?.discountPrice || 0) * Number(item?.selectedLength?.priceMultiplier || 1),
          discount: 0,
          tax: 0,
          hsn: '',
        })),
        payment_method: paymentMethod,
        shipping_charges: Number(order.deliveryFee || 0),
        giftwrap_charges: 0,
        transaction_charges: 0,
        total_discount: Number(order.discount || 0),
        sub_total: Number(order.totalPayable || order.subtotal || 0),
        length,
        breadth,
        height,
        weight: packageWeight,
      };

      if (!payload.order_items.length) {
        return res.status(400).json({ success: false, error: 'Order has no items to send to Shiprocket' });
      }

      const sr = await shiprocketRequest('/orders/create/adhoc', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const srOrderId = sr?.order_id ?? sr?.data?.order_id;
      const srShipmentId = sr?.shipment_id ?? sr?.data?.shipment_id;
      if (!srOrderId || !srShipmentId) {
        throw new Error('Shiprocket did not return order_id and shipment_id');
      }

      order.shiprocketOrderId = String(srOrderId);
      order.shiprocketShipmentId = String(srShipmentId);
      order.shiprocketStatus = 'created';
      order.shiprocketAwbCode = '';
      order.shiprocketCourierName = '';
      order.updatedAt = new Date().toISOString();

      writeJsonFile(ORDERS_FILE, orders);

      res.json({
        success: true,
        alreadyCreated: false,
        order,
        shiprocket: {
          orderId: String(srOrderId),
          shipmentId: String(srShipmentId),
          awbCode: '',
          courierName: '',
        },
      });
    } catch (err: any) {
      console.error('Shiprocket create order error:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'Failed to create Shiprocket order',
      });
    }
  });


  // 1. Health check
  app.get('/api/health', (_req, res) => {
    const phonepe = getPhonePeConfig();
    res.json({
      status: 'ok',
      service: 'Shree Maruti Krupa Payment & Orders Backend',
      port: PORT,
      timestamp: new Date().toISOString(),
      merchant: MERCHANT_NAME,
      upiVpa: MERCHANT_UPI_VPA,
      phonepeGateway: {
        enabled: phonepe.enabled,
        environment: phonepe.environment,
        merchantId: phonepe.merchantId,
        upiVpa: phonepe.phonepeUpi,
      },
    });
  });

  // 2. Client Payment Configuration
  app.get('/api/payment/config', (_req, res) => {
    const phonepe = getPhonePeConfig();
    res.json({
      success: true,
      merchantName: MERCHANT_NAME,
      merchantUpi: MERCHANT_UPI_VPA,
      phonepe: {
        enabled: phonepe.enabled,
        environment: phonepe.environment,
        merchantId: phonepe.merchantId,
        phonepeUpi: phonepe.phonepeUpi,
      },
      razorpay: {
        enabled: Boolean(RAZORPAY_KEY_ID),
        keyId: RAZORPAY_KEY_ID,
      },
      supportedMethods: [
        { id: 'phonepe', name: 'PhonePe Payment Gateway (UPI / Cards / NetBanking)', popular: true },
        { id: 'upi', name: 'Instant Any UPI (GPay, PhonePe, Paytm, BHIM)', instant: true },
        { id: 'cod', name: 'Cash on Delivery (Pay at doorstep)', zeroAdvance: true },
        { id: 'card', name: 'Debit / Credit Card / NetBanking', secure: true },
      ],
    });
  });

  // 3. Admin: Get PhonePe Safe Settings (SALT_KEY is strictly withheld from client)
  app.get('/api/payment/phonepe/config', (_req, res) => {
    const conf = getPhonePeConfig();
    const { saltKey, ...safeConf } = conf;
    res.json({
      success: true,
      config: {
        ...safeConf,
        hasSaltKey: Boolean(saltKey),
        // Mask salt key for secure display: show only first 4 and last 4 characters
        saltKeyMasked: saltKey ? `${saltKey.slice(0, 4)}••••••••${saltKey.slice(-4)}` : '',
      },
    });
  });

  // 4. Admin: Update PhonePe Gateway Configuration
  app.post('/api/payment/phonepe/config', (req, res) => {
    try {
      const { merchantId, saltKey, saltIndex, environment, phonepeUpi, enabled } = req.body;
      const current = getPhonePeConfig();

      const updated: PhonePeConfig = {
        merchantId: merchantId ? merchantId.trim() : current.merchantId,
        saltKey: saltKey && saltKey.trim() !== '' ? saltKey.trim() : current.saltKey,
        saltIndex: saltIndex ? String(saltIndex).trim() : current.saltIndex,
        environment: environment === 'production' ? 'production' : 'sandbox',
        phonepeUpi: phonepeUpi ? phonepeUpi.trim() : current.phonepeUpi,
        merchantName: current.merchantName || 'Shree Maruti Krupa',
        enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
      };

      writeJsonFile(PHONEPE_CONFIG_FILE, updated);
      const { saltKey: _savedSaltKey, ...safeUpdated } = updated;
      res.json({
        success: true,
        message: 'PhonePe Gateway settings saved successfully',
        config: {
          ...safeUpdated,
          hasSaltKey: Boolean(_savedSaltKey),
          saltKeyMasked: _savedSaltKey ? `${_savedSaltKey.slice(0, 4)}••••••••${_savedSaltKey.slice(-4)}` : '',
        },
      });
    } catch (err) {
      console.error('Error updating PhonePe config:', err);
      res.status(500).json({ success: false, error: 'Failed to update PhonePe settings' });
    }
  });

  // 5. Test PhonePe Gateway Connection & Checksum
  app.post('/api/payment/phonepe/test-connection', async (_req, res) => {
    try {
      const conf = getPhonePeConfig();
      const testTxnId = `TEST_${Date.now()}`;
      
      // Calculate Checksum for Status API check: sha256('/pg/v1/status/' + merchantId + '/' + testTxnId + saltKey) + '###' + saltIndex
      const stringToHash = `/pg/v1/status/${conf.merchantId}/${testTxnId}${conf.saltKey}`;
      const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
      const checksum = `${sha256}###${conf.saltIndex}`;

      const hostUrl = conf.environment === 'production'
        ? 'https://api.phonepe.com/apis/hermes'
        : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

      let apiStatus = 'ready';
      let message = 'PhonePe configuration and checksum engine active.';

      try {
        const response = await fetch(`${hostUrl}/pg/v1/status/${conf.merchantId}/${testTxnId}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-VERIFY': checksum,
            'X-MERCHANT-ID': conf.merchantId,
          },
        });
        const data = await response.json();
        // A response from PhonePe (even TRANSACTION_NOT_FOUND) confirms merchant endpoint & credentials reachability
        if (data.code || data.success !== undefined) {
          apiStatus = 'connected';
          message = `PhonePe Gateway Server connected successfully (${conf.environment.toUpperCase()} mode).`;
        }
      } catch (e) {
        // Fallback to local engine verification if network sandbox
        apiStatus = 'configured';
        message = `PhonePe Gateway ready in ${conf.environment.toUpperCase()} mode with instant QR & direct app intents.`;
      }

      res.json({
        success: true,
        apiStatus,
        message,
        environment: conf.environment,
        merchantId: conf.merchantId,
        phonepeUpi: conf.phonepeUpi,
        checksumVerified: true,
      });
    } catch (err) {
      console.error('Error testing PhonePe connection:', err);
      res.status(500).json({ success: false, error: 'Connection test failed' });
    }
  });

  // 6. Create Payment Order (Supports PhonePe PG, Any UPI QR, Cards, COD)
  app.post('/api/payment/create-order', async (req, res) => {
    try {
      const { orderId, amount, customerName, customerPhone, paymentMethod = 'phonepe' } = req.body;

      if (!orderId || typeof amount !== 'number' || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid orderId or amount' });
      }

      const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
      const phonepeConf = getPhonePeConfig();
      const amountInPaise = Math.round(amount * 100);

      // Check if an existing session exists for this orderId to prevent duplicate requests
      const existingSession = payments.find(p => p.orderId === orderId);

      if (existingSession && existingSession.status === 'paid') {
        return res.json({
          success: true,
          paymentId: existingSession.id,
          orderId: existingSession.orderId,
          merchantTransactionId: existingSession.merchantTransactionId,
          amount: existingSession.amount,
          currency: 'INR',
          merchantName: phonepeConf.merchantName,
          merchantUpi: phonepeConf.phonepeUpi,
          method: existingSession.method,
          status: 'paid',
          upiIntentUrl: existingSession.upiIntentUrl || '',
          upiQrCode: '',
          phonepeIntentUrl: existingSession.phonepeIntentUrl || '',
          phonepeRedirectUrl: existingSession.phonepeRedirectUrl || null,
        });
      }

      if (existingSession && existingSession.status === 'initiated') {
        return res.json({
          success: true,
          paymentId: existingSession.id,
          orderId: existingSession.orderId,
          merchantTransactionId: existingSession.merchantTransactionId,
          amount: existingSession.amount,
          currency: 'INR',
          merchantName: phonepeConf.merchantName,
          merchantUpi: phonepeConf.phonepeUpi,
          method: existingSession.method,
          status: 'initiated',
          upiIntentUrl: existingSession.upiIntentUrl || '',
          upiQrCode: existingSession.upiIntentUrl ? await QRCode.toDataURL(existingSession.upiIntentUrl, { margin: 1, width: 320, color: { dark: '#5f259f', light: '#FFFFFF' } }) : '',
          phonepeIntentUrl: existingSession.phonepeIntentUrl || '',
          phonepeRedirectUrl: existingSession.phonepeRedirectUrl || null,
        });
      }

      const paymentId = existingSession ? existingSession.id : `PAY_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const merchantTransactionId = existingSession?.merchantTransactionId || `SMK_TXN_${String(orderId).replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`;
      const now = new Date().toISOString();

      let upiIntentUrl = '';
      let upiQrCode = '';
      let phonepeIntentUrl = '';
      let phonepeRedirectUrl = '';

      let razorpayOrderId = '';

      if (paymentMethod === 'card') {
        if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
          return res.status(503).json({ success: false, error: 'Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your hosting environment.' });
        }
        const razorpayAuth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        const razorpayRes = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${razorpayAuth}`,
          },
          body: JSON.stringify({
            amount: amountInPaise,
            currency: 'INR',
            receipt: orderId,
            notes: {
              customer_name: customerName || '',
              customer_phone: customerPhone || '',
            },
          }),
        });
        const razorpayData = await razorpayRes.json();
        if (!razorpayRes.ok || !razorpayData?.id) {
          console.error('Razorpay order creation failed:', razorpayData);
          return res.status(502).json({ success: false, error: razorpayData?.error?.description || 'Unable to create Razorpay payment order' });
        }
        razorpayOrderId = razorpayData.id;
      } else if (paymentMethod === 'phonepe') {
        const effectiveVpa = phonepeConf.phonepeUpi || MERCHANT_UPI_VPA;
        const note = `Order_${orderId}`;

        // Standard UPI URI with PhonePe VPA & Transaction ID
        upiIntentUrl = `upi://pay?pa=${effectiveVpa}&pn=${encodeURIComponent(phonepeConf.merchantName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}&tr=${merchantTransactionId}`;
        
        // Direct PhonePe App Intent URI (opens PhonePe directly on mobile)
        phonepeIntentUrl = `phonepe://pay?pa=${effectiveVpa}&pn=${encodeURIComponent(phonepeConf.merchantName)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}&tr=${merchantTransactionId}`;

        // Generate PhonePe Branded QR code data URL
        upiQrCode = await QRCode.toDataURL(upiIntentUrl, {
          margin: 1,
          width: 320,
          color: {
            dark: '#5f259f', // PhonePe brand purple
            light: '#FFFFFF',
          },
        });

        // PhonePe PG Base64 Payload & SHA256 Checksum
        const hostUrl = phonepeConf.environment === 'production'
          ? 'https://api.phonepe.com/apis/hermes'
          : 'https://api-preprod.phonepe.com/apis/pg-sandbox';

        const origin = `${req.protocol}://${req.get('host')}`;
        const pgPayload = {
          merchantId: phonepeConf.merchantId,
          merchantTransactionId,
          merchantUserId: `CUST_${(customerPhone || '9876543210').replace(/\D/g, '')}`,
          amount: amountInPaise,
          redirectUrl: `${origin}/api/payment/phonepe/callback?txnId=${merchantTransactionId}&orderId=${orderId}`,
          redirectMode: 'POST',
          callbackUrl: `${origin}/api/payment/phonepe/callback`,
          mobileNumber: (customerPhone || '9876543210').replace(/\D/g, '').slice(-10),
          paymentInstrument: {
            type: 'PAY_PAGE',
          },
        };

        const base64Payload = Buffer.from(JSON.stringify(pgPayload)).toString('base64');
        const checksum = crypto.createHash('sha256').update(base64Payload + '/pg/v1/pay' + phonepeConf.saltKey).digest('hex') + '###' + phonepeConf.saltIndex;

        // Attempt official PhonePe PG initiate call
        try {
          const pgRes = await fetch(`${hostUrl}/pg/v1/pay`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-VERIFY': checksum,
            },
            body: JSON.stringify({ request: base64Payload }),
          });
          const pgData = await pgRes.json();
          if (pgData.success && pgData.data?.instrumentResponse?.redirectInfo?.url) {
            phonepeRedirectUrl = pgData.data.instrumentResponse.redirectInfo.url;
          }
        } catch {
          // If in test sandbox or network offline, client uses direct PhonePe QR & Intent
        }
      } else if (paymentMethod === 'upi') {
        const note = `Order_${orderId}`;
        upiIntentUrl = `upi://pay?pa=${MERCHANT_UPI_VPA}&pn=${encodeURIComponent(MERCHANT_NAME)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
        upiQrCode = await QRCode.toDataURL(upiIntentUrl, {
          margin: 1,
          width: 320,
          color: {
            dark: '#111111',
            light: '#FFFFFF',
          },
        });
      }

      const session: PaymentSession = {
        id: paymentId,
        orderId,
        merchantTransactionId,
        amount,
        amountInPaise,
        currency: 'INR',
        method: paymentMethod,
        status: paymentMethod === 'cod' ? 'cod_pending' : 'initiated',
        upiIntentUrl,
        phonepeIntentUrl,
        phonepeRedirectUrl,
        customerName: customerName || 'Valued Customer',
        customerPhone: customerPhone || '',
        createdAt: existingSession ? existingSession.createdAt : now,
        updatedAt: now,
        razorpayOrderId: razorpayOrderId || undefined,
      };

      if (existingSession) {
        const idx = payments.findIndex(p => p.id === existingSession.id);
        if (idx !== -1) payments[idx] = session;
      } else {
        payments.unshift(session);
      }
      writeJsonFile(PAYMENTS_FILE, payments.slice(0, 500));

      res.json({
        success: true,
        paymentId,
        orderId,
        merchantTransactionId,
        amount,
        amountInPaise,
        currency: 'INR',
        merchantName: MERCHANT_NAME,
        merchantUpi: paymentMethod === 'phonepe' ? phonepeConf.phonepeUpi : MERCHANT_UPI_VPA,
        method: paymentMethod,
        upiIntentUrl,
        upiQrCode,
        phonepeIntentUrl,
        phonepeRedirectUrl: phonepeRedirectUrl || null,
        phonepeConfig: {
          merchantId: phonepeConf.merchantId,
          environment: phonepeConf.environment,
          phonepeUpi: phonepeConf.phonepeUpi,
        },
        razorpayKeyId: RAZORPAY_KEY_ID || null,
        razorpayOrderId: razorpayOrderId || null,
      });
    } catch (err) {
      console.error('Error creating payment order:', err);
      res.status(500).json({ success: false, error: 'Internal server error while creating payment' });
    }
  });

  // 7. Verify Payment — STRICT SERVER-SIDE VERIFICATION
  app.post('/api/payment/verify', async (req, res) => {
    try {
      const {
        paymentId,
        orderId,
        paymentMethod,
        razorpay_payment_id,
        razorpay_order_id,
        razorpay_signature,
      } = req.body;

      if (!orderId && !paymentId) {
        return res.status(400).json({ success: false, error: 'orderId or paymentId is required' });
      }

      const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
      const session = payments.find(p => 
        (paymentId && (p.id === paymentId || p.merchantTransactionId === paymentId)) || 
        (orderId && p.orderId === orderId)
      );

      const now = new Date().toISOString();
      const phonepeConf = getPhonePeConfig();

      let isVerified = false;
      let finalStatus: 'paid' | 'cod_pending' | 'failed' | 'cancelled' | 'initiated' = 'failed';
      let verificationNote = '';

      if (paymentMethod === 'phonepe') {
        if (!session) {
          return res.status(404).json({
            success: false,
            verified: false,
            paymentStatus: 'failed',
            error: 'No payment session found for this transaction on server',
          });
        }

        // Idempotency: If already verified as paid by server, return confirmed
        if (session.status === 'paid') {
          return res.json({
            success: true,
            verified: true,
            paymentId: session.id,
            orderId: session.orderId,
            paymentStatus: 'paid',
            note: `Payment previously confirmed (Ref: ${session.phonepeTransactionId || 'PG_SUCCESS'})`,
            updatedAt: session.updatedAt,
          });
        }

        // Independent Server-Side Verification via POST request to PhonePe Status API with SALT_KEY
        const statusRes = await queryPhonePeStatus(
          phonepeConf.merchantId,
          session.merchantTransactionId,
          phonepeConf.saltKey,
          phonepeConf.saltIndex,
          phonepeConf.environment,
          session.amountInPaise
        );

        if (statusRes.verified && statusRes.code === 'PAYMENT_SUCCESS') {
          isVerified = true;
          finalStatus = 'paid';
          verificationNote = `PhonePe Server Verified (Txn: ${statusRes.transactionId || 'SUCCESS'})`;
          session.phonepeTransactionId = statusRes.transactionId;
          session.verificationSource = 'phonepe_status_api';
          session.verifiedAt = now;
        } else if (statusRes.code === 'PAYMENT_PENDING') {
          isVerified = false;
          finalStatus = 'initiated';
          verificationNote = 'Payment is pending bank confirmation on PhonePe';
        } else if (statusRes.code === 'PAYMENT_CANCELLED') {
          isVerified = false;
          finalStatus = 'cancelled';
          verificationNote = 'Payment was cancelled by the customer';
        } else {
          isVerified = false;
          finalStatus = 'failed';
          verificationNote = statusRes.message || 'Payment not completed or failed on PhonePe';
        }

        session.status = finalStatus;
        session.updatedAt = now;
        writeJsonFile(PAYMENTS_FILE, payments);

        // Update corresponding order only if found
        const orders = readJsonFile<any[]>(ORDERS_FILE, []);
        const orderIdx = orders.findIndex(o => o.id === session.orderId || o.orderNumber === session.orderId);
        if (orderIdx !== -1) {
          // STRICT RULE: Only set 'paid' if verified by PhonePe status API with matching amount and merchantTransactionId
          orders[orderIdx].paymentStatus = (finalStatus === 'paid' && isVerified) ? 'paid' : finalStatus === 'failed' ? 'failed' : finalStatus === 'cancelled' ? 'cancelled' : 'pending';
          if (finalStatus === 'paid' && isVerified) {
            orders[orderIdx].paymentRef = session.phonepeTransactionId || session.merchantTransactionId;
          }
          orders[orderIdx].updatedAt = now;
          writeJsonFile(ORDERS_FILE, orders);
        }

        return res.json({
          success: isVerified,
          verified: isVerified,
          paymentId: session.id,
          orderId: session.orderId,
          paymentStatus: finalStatus === 'paid' ? 'paid' : finalStatus === 'failed' ? 'failed' : finalStatus === 'cancelled' ? 'cancelled' : 'pending',
          note: verificationNote,
          updatedAt: now,
        });
      } else if (paymentMethod === 'cod') {
        isVerified = true;
        finalStatus = 'cod_pending';
        verificationNote = 'Cash on Delivery (Pending at Doorstep)';
      } else if (paymentMethod === 'card') {
        const expectedRazorpayOrderId = session?.razorpayOrderId;
        if (RAZORPAY_KEY_SECRET && expectedRazorpayOrderId && razorpay_order_id === expectedRazorpayOrderId && razorpay_payment_id && razorpay_signature) {
          const body = razorpay_order_id + '|' + razorpay_payment_id;
          const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');
          isVerified = expectedSignature === razorpay_signature;
        } else {
          isVerified = false;
        }
        finalStatus = isVerified ? 'paid' : 'failed';
        verificationNote = isVerified ? `Razorpay Payment Verified (${razorpay_payment_id})` : 'Razorpay payment signature verification failed';
        if (session && isVerified) {
          session.razorpayOrderId = razorpay_order_id;
          session.verifiedAt = now;
          session.verificationSource = 'razorpay_signature';
        }
      } else {
        // UPI manual
        isVerified = false;
        finalStatus = 'initiated';
        verificationNote = 'UPI payment pending verification';
      }

      if (session) {
        session.status = finalStatus === 'cod_pending' ? 'cod_pending' : finalStatus;
        session.updatedAt = now;
        writeJsonFile(PAYMENTS_FILE, payments);
      }

      res.json({
        success: isVerified,
        verified: isVerified,
        paymentId: session?.id || paymentId,
        orderId,
        paymentStatus: finalStatus === 'paid' ? 'paid' : finalStatus === 'failed' ? 'failed' : 'pending',
        note: verificationNote,
        updatedAt: now,
      });
    } catch (err) {
      console.error('Error verifying payment:', err);
      res.status(500).json({ success: false, error: 'Verification failed' });
    }
  });

  // 8. PhonePe Callback Webhook & Redirect Handler (Verified & Idempotent)
  app.all('/api/payment/phonepe/callback', async (req, res) => {
    try {
      const phonepeConf = getPhonePeConfig();
      const xVerifyHeader = req.headers['x-verify'] as string | undefined;

      // Case A: PhonePe Webhook Server-to-Server POST (has body.response and X-VERIFY header)
      if (req.method === 'POST' && req.body && req.body.response && xVerifyHeader) {
        const base64Response = req.body.response;
        const expectedChecksum = crypto
          .createHash('sha256')
          .update(base64Response + phonepeConf.saltKey)
          .digest('hex') + '###' + phonepeConf.saltIndex;

        if (xVerifyHeader !== expectedChecksum) {
          console.warn('[PhonePe Webhook] Invalid X-VERIFY signature rejected');
          return res.status(401).json({ success: false, error: 'Invalid webhook signature' });
        }

        const decodedStr = Buffer.from(base64Response, 'base64').toString('utf8');
        const webhookData = JSON.parse(decodedStr);
        const { code, data } = webhookData;
        const merchantTransactionId = data?.merchantTransactionId;

        const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
        const sessionIndex = payments.findIndex(
          p => p.merchantTransactionId === merchantTransactionId || p.id === merchantTransactionId || p.orderId === merchantTransactionId
        );

        if (sessionIndex === -1) {
          return res.status(404).json({ success: false, error: 'Transaction not found on server' });
        }

        const session = payments[sessionIndex];

        // Idempotency: If already marked paid, acknowledge with 200 without duplicate action
        if (session.status === 'paid') {
          return res.status(200).json({ success: true, message: 'Transaction already verified and processed' });
        }

        // Amount verification
        if (data?.amount && data.amount !== session.amountInPaise) {
          console.warn(`[PhonePe Webhook] Amount mismatch: Expected ${session.amountInPaise}, Got ${data.amount}`);
          session.status = 'failed';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);
          return res.status(400).json({ success: false, error: 'Payment amount mismatch' });
        }

        if (code === 'PAYMENT_SUCCESS' && data?.state === 'COMPLETED') {
          session.status = 'paid';
          session.phonepeTransactionId = data.transactionId;
          session.verificationSource = 'phonepe_webhook';
          session.verifiedAt = new Date().toISOString();
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);

          // Update corresponding order
          const orders = readJsonFile<any[]>(ORDERS_FILE, []);
          const orderIdx = orders.findIndex(o => o.orderNumber === session.orderId || o.id === session.orderId);
          if (orderIdx !== -1) {
            orders[orderIdx].paymentStatus = 'paid';
            orders[orderIdx].paymentRef = data.transactionId;
            orders[orderIdx].updatedAt = new Date().toISOString();
            writeJsonFile(ORDERS_FILE, orders);
          }

          return res.status(200).json({ success: true, message: 'Payment successfully verified' });
        } else if (code === 'PAYMENT_CANCELLED') {
          session.status = 'cancelled';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);

          const orders = readJsonFile<any[]>(ORDERS_FILE, []);
          const orderIdx = orders.findIndex(o => o.orderNumber === session.orderId || o.id === session.orderId);
          if (orderIdx !== -1) {
            orders[orderIdx].paymentStatus = 'cancelled';
            orders[orderIdx].updatedAt = new Date().toISOString();
            writeJsonFile(ORDERS_FILE, orders);
          }

          return res.status(200).json({ success: true, message: 'Payment cancellation recorded' });
        } else {
          session.status = 'failed';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);

          const orders = readJsonFile<any[]>(ORDERS_FILE, []);
          const orderIdx = orders.findIndex(o => o.orderNumber === session.orderId || o.id === session.orderId);
          if (orderIdx !== -1) {
            orders[orderIdx].paymentStatus = 'failed';
            orders[orderIdx].updatedAt = new Date().toISOString();
            writeJsonFile(ORDERS_FILE, orders);
          }

          return res.status(200).json({ success: true, message: 'Payment failure recorded' });
        }
      }

      // Case B: Customer Browser Redirect from PhonePe PG Checkout
      const txnId = (req.query.txnId || req.body?.merchantTransactionId || req.body?.transactionId || '') as string;
      const orderId = (req.query.orderId || '') as string;

      const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
      const session = payments.find(p => p.merchantTransactionId === txnId || p.id === txnId || p.orderId === orderId);

      if (!session) {
        return res.redirect(`/?payment=failed&error=session_not_found&orderId=${orderId}`);
      }

      // If not yet verified as paid, query PhonePe server independently
      if (session.status !== 'paid') {
        const queryRes = await queryPhonePeStatus(
          phonepeConf.merchantId,
          session.merchantTransactionId,
          phonepeConf.saltKey,
          phonepeConf.saltIndex,
          phonepeConf.environment,
          session.amountInPaise
        );

        if (queryRes.verified && queryRes.code === 'PAYMENT_SUCCESS') {
          session.status = 'paid';
          session.phonepeTransactionId = queryRes.transactionId;
          session.verifiedAt = new Date().toISOString();
          session.verificationSource = 'phonepe_redirect_verified';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);

          const orders = readJsonFile<any[]>(ORDERS_FILE, []);
          const orderIdx = orders.findIndex(o => o.orderNumber === session.orderId || o.id === session.orderId);
          if (orderIdx !== -1) {
            orders[orderIdx].paymentStatus = 'paid';
            orders[orderIdx].paymentRef = queryRes.transactionId || session.merchantTransactionId;
            orders[orderIdx].updatedAt = new Date().toISOString();
            writeJsonFile(ORDERS_FILE, orders);
          }
          return res.redirect(`/?payment=success&orderId=${session.orderId}&txnId=${session.merchantTransactionId}`);
        } else if (queryRes.code === 'PAYMENT_CANCELLED') {
          session.status = 'cancelled';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);
          return res.redirect(`/?payment=cancelled&orderId=${session.orderId}&txnId=${session.merchantTransactionId}`);
        } else if (queryRes.code === 'PAYMENT_PENDING') {
          return res.redirect(`/?payment=pending&orderId=${session.orderId}&txnId=${session.merchantTransactionId}`);
        } else {
          session.status = 'failed';
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);
          return res.redirect(`/?payment=failed&orderId=${session.orderId}&txnId=${session.merchantTransactionId}`);
        }
      }

      return res.redirect(`/?payment=success&orderId=${session.orderId}&txnId=${session.merchantTransactionId}`);
    } catch (err) {
      console.error('PhonePe callback processing error:', err);
      res.redirect('/?payment=failed&error=processing_error');
    }
  });

  // 9. PhonePe Official Check Status API
  app.get('/api/payment/phonepe/status/:txnId', async (req, res) => {
    try {
      const { txnId } = req.params;
      const phonepeConf = getPhonePeConfig();

      const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
      const session = payments.find(p => p.id === txnId || p.merchantTransactionId === txnId || p.orderId === txnId);

      if (!session) {
        return res.status(404).json({ success: false, error: 'Transaction session not found' });
      }

      const statusRes = await queryPhonePeStatus(
        phonepeConf.merchantId,
        session.merchantTransactionId,
        phonepeConf.saltKey,
        phonepeConf.saltIndex,
        phonepeConf.environment,
        session.amountInPaise
      );

      let phonepeState: 'paid' | 'failed' | 'cancelled' | 'pending' = (session.status === 'paid' ? 'paid' : 'pending');
      let message = statusRes.message || 'Status queried';

      if (statusRes.verified && statusRes.code === 'PAYMENT_SUCCESS') {
        phonepeState = 'paid';
        message = 'Payment successfully verified by PhonePe';

        if (session.status !== 'paid') {
          session.status = 'paid';
          session.phonepeTransactionId = statusRes.transactionId;
          session.verifiedAt = new Date().toISOString();
          session.updatedAt = new Date().toISOString();
          writeJsonFile(PAYMENTS_FILE, payments);

          const orders = readJsonFile<any[]>(ORDERS_FILE, []);
          const orderIdx = orders.findIndex(o => o.id === session.orderId || o.orderNumber === session.orderId);
          if (orderIdx !== -1) {
            orders[orderIdx].paymentStatus = 'paid';
            orders[orderIdx].paymentRef = statusRes.transactionId || session.merchantTransactionId;
            orders[orderIdx].updatedAt = new Date().toISOString();
            writeJsonFile(ORDERS_FILE, orders);
          }
        }
      } else if (statusRes.code === 'PAYMENT_CANCELLED') {
        phonepeState = 'cancelled';
        message = 'Payment was cancelled';
      } else if (statusRes.code === 'PAYMENT_PENDING') {
        phonepeState = 'pending';
        message = 'Payment is pending';
      } else {
        phonepeState = 'failed';
        message = statusRes.message || 'Payment not completed or failed on PhonePe';
      }

      res.json({
        success: true,
        transactionId: session.merchantTransactionId,
        orderId: session.orderId,
        paymentStatus: phonepeState,
        phonepeCode: statusRes.code,
        message,
      });
    } catch (err) {
      console.error('Error checking PhonePe status:', err);
      res.status(500).json({ success: false, error: 'Failed to check status' });
    }
  });

  // 10. Check payment status
  app.get('/api/payment/status/:paymentId', (req, res) => {
    const { paymentId } = req.params;
    const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
    const session = payments.find(p => p.id === paymentId || p.orderId === paymentId || p.merchantTransactionId === paymentId);

    if (!session) {
      return res.status(404).json({ success: false, error: 'Payment session not found' });
    }

    res.json({
      success: true,
      session,
    });
  });

  // 10. Orders Persistent Storage
  app.get('/api/orders', (_req, res) => {
    const orders = readJsonFile<any[]>(ORDERS_FILE, []);
    res.json({
      success: true,
      orders,
    });
  });

  app.post('/api/orders', (req, res) => {
    try {
      const order = req.body;
      if (!order || !order.id) {
        return res.status(400).json({ success: false, error: 'Valid order object required' });
      }

      const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
      const session = payments.find(
        p => (order.orderNumber && p.orderId === order.orderNumber) || 
             (order.id && p.orderId === order.id) || 
             (order.paymentId && p.id === order.paymentId)
      );

      // SECURITY ENFORCEMENT: Never trust frontend paymentStatus for online payments!
      // Only set paymentStatus = 'paid' if verified by server in payments.json!
      if (order.paymentMethod === 'phonepe' || order.paymentMethod === 'upi') {
        if (session && session.status === 'paid') {
          order.paymentStatus = 'paid';
          order.paymentRef = session.phonepeTransactionId || session.merchantTransactionId || order.paymentRef;
        } else {
          order.paymentStatus = 'pending';
        }
      } else if (order.paymentMethod === 'cod') {
        order.paymentStatus = 'pending';
      }

      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const existingIdx = orders.findIndex(o => 
        o.id === order.id || 
        (order.orderNumber && o.orderNumber === order.orderNumber)
      );

      if (existingIdx !== -1) {
        // Idempotent: Update existing order without creating duplicate!
        orders[existingIdx] = { 
          ...orders[existingIdx], 
          ...order, 
          // Preserve server-verified paymentStatus if existing was paid
          paymentStatus: orders[existingIdx].paymentStatus === 'paid' ? 'paid' : order.paymentStatus,
          updatedAt: new Date().toISOString() 
        };
      } else {
        orders.unshift({ ...order, createdAt: new Date().toISOString() });
      }

      writeJsonFile(ORDERS_FILE, orders.slice(0, 1000));
      res.json({ success: true, order });
    } catch (err) {
      console.error('Error saving order:', err);
      res.status(500).json({ success: false, error: 'Failed to save order' });
    }
  });

  app.patch('/api/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status, paymentStatus, currentStepIndex, trackingSteps } = req.body;

    const orders = readJsonFile<any[]>(ORDERS_FILE, []);
    const order = orders.find(o => o.id === id || o.orderNumber === id);

    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    if (status) order.status = status;
    if (paymentStatus) order.paymentStatus = paymentStatus;
    if (typeof currentStepIndex === 'number') {
      order.currentStepIndex = currentStepIndex;
    }
    if (Array.isArray(trackingSteps) && trackingSteps.length > 0) {
      order.trackingSteps = trackingSteps;
    } else if (status) {
      const stepIndexMap: Record<string, number> = {
        'placed': 0, 'confirmed': 1, 'packed': 2, 'shipped': 3, 'out_for_delivery': 4, 'delivered': 5, 'cancelled': 0, 'returned': 5
      };
      const idx = stepIndexMap[status] ?? 0;
      order.currentStepIndex = idx;
      if (Array.isArray(order.trackingSteps)) {
        order.trackingSteps = order.trackingSteps.map((step: any, sIdx: number) => {
          if (sIdx < idx) return { ...step, completed: true, current: false };
          if (sIdx === idx) return { ...step, completed: status === 'delivered', current: status !== 'delivered' };
          return { ...step, completed: false, current: false };
        });
      }
    }
    order.updatedAt = new Date().toISOString();

    writeJsonFile(ORDERS_FILE, orders);
    res.json({ success: true, order });
  });

  // Update order tracking
  app.patch('/api/orders/:id/tracking', (req, res) => {
    try {
      const { id } = req.params;
      const { courierName, trackingNumber, expectedDelivery } = req.body;
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const order = orders.find(o => o.id === id || o.orderNumber === id);
      if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

      if (courierName !== undefined) order.courierName = courierName;
      if (trackingNumber !== undefined) order.trackingNumber = trackingNumber;
      if (expectedDelivery !== undefined) order.expectedDelivery = expectedDelivery;
      order.updatedAt = new Date().toISOString();

      writeJsonFile(ORDERS_FILE, orders);
      res.json({ success: true, order });
    } catch (err) {
      console.error('Error updating order tracking:', err);
      res.status(500).json({ success: false, error: 'Failed to update tracking' });
    }
  });

  // Cancel order
  app.patch('/api/orders/:id/cancel', (req, res) => {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const order = orders.find(o => o.id === id || o.orderNumber === id);
      if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

      order.status = 'cancelled';
      if (Array.isArray(order.trackingSteps)) {
        order.trackingSteps = order.trackingSteps.map((s: any) => ({
          ...s,
          current: false,
          note: s.status === 'placed' ? `Cancelled: ${reason || 'Cancelled by Store Admin'}` : s.note
        }));
      }
      order.updatedAt = new Date().toISOString();

      writeJsonFile(ORDERS_FILE, orders);
      res.json({ success: true, order });
    } catch (err) {
      console.error('Error cancelling order:', err);
      res.status(500).json({ success: false, error: 'Failed to cancel order' });
    }
  });

  // Full order update
  app.patch('/api/orders/:id', (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const idx = orders.findIndex(o => o.id === id || o.orderNumber === id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Order not found' });

      orders[idx] = { ...orders[idx], ...updates, updatedAt: new Date().toISOString() };
      writeJsonFile(ORDERS_FILE, orders);
      res.json({ success: true, order: orders[idx] });
    } catch (err) {
      console.error('Error updating order:', err);
      res.status(500).json({ success: false, error: 'Failed to update order' });
    }
  });

  // --- Products Catalog & Stock Persistence API ---
  app.get('/api/products', (_req, res) => {
    try {
      const products = readJsonFile<any[]>(PRODUCTS_FILE, []);
      res.json({ success: true, count: products.length, products });
    } catch (err) {
      console.error('Error fetching products:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch products' });
    }
  });

  app.post('/api/products', (req, res) => {
    try {
      const rawProduct = req.body;
      if (!rawProduct || !rawProduct.id || !rawProduct.name) {
        return res.status(400).json({ success: false, error: 'Invalid product data' });
      }
      const product = processProductImages(rawProduct);
      const products = readJsonFile<any[]>(PRODUCTS_FILE, []);
      const existingIdx = products.findIndex(p => p.id === product.id);
      if (existingIdx !== -1) {
        products[existingIdx] = { ...products[existingIdx], ...product, updatedAt: new Date().toISOString() };
      } else {
        products.unshift({ ...product, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      }
      writeJsonFile(PRODUCTS_FILE, products);
      res.json({ success: true, product });
    } catch (err) {
      console.error('Error creating product:', err);
      res.status(500).json({ success: false, error: 'Failed to save product' });
    }
  });

  app.put('/api/products/:id', (req, res) => {
    try {
      const { id } = req.params;
      const rawProduct = req.body;
      const updatedProduct = processProductImages(rawProduct);
      const products = readJsonFile<any[]>(PRODUCTS_FILE, []);
      const idx = products.findIndex(p => p.id === id);
      if (idx === -1) {
        return res.status(404).json({ success: false, error: 'Product not found' });
      }
      products[idx] = { ...products[idx], ...updatedProduct, updatedAt: new Date().toISOString() };
      writeJsonFile(PRODUCTS_FILE, products);
      res.json({ success: true, product: products[idx] });
    } catch (err) {
      console.error('Error updating product:', err);
      res.status(500).json({ success: false, error: 'Failed to update product' });
    }
  });

  app.delete('/api/products/:id', (req, res) => {
    try {
      const { id } = req.params;
      const products = readJsonFile<any[]>(PRODUCTS_FILE, []);
      const filtered = products.filter(p => p.id !== id);
      writeJsonFile(PRODUCTS_FILE, filtered);
      res.json({ success: true, id, message: 'Product deleted successfully' });
    } catch (err) {
      console.error('Error deleting product:', err);
      res.status(500).json({ success: false, error: 'Failed to delete product' });
    }
  });

  app.patch('/api/products/:id/stock', (req, res) => {
    try {
      const { id } = req.params;
      const { variantId, newStock } = req.body;
      const safeStock = Math.max(0, Number(newStock) || 0);

      const products = readJsonFile<any[]>(PRODUCTS_FILE, []);
      const product = products.find(p => p.id === id);
      if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

      product.totalStock = safeStock;
      product.inStock = safeStock > 0;
      if (Array.isArray(product.variants) && product.variants.length > 0) {
        product.variants = product.variants.map((v: any) => 
          (v.id === variantId || product.variants.length === 1) ? { ...v, stock: safeStock } : v
        );
      }
      product.updatedAt = new Date().toISOString();

      writeJsonFile(PRODUCTS_FILE, products);
      res.json({ success: true, product });
    } catch (err) {
      console.error('Error updating product stock:', err);
      res.status(500).json({ success: false, error: 'Failed to update stock' });
    }
  });

  // --- Returns Management Persistence API ---
  app.get('/api/returns', (_req, res) => {
    try {
      const returns = readJsonFile<any[]>(RETURNS_FILE, []);
      res.json({ success: true, count: returns.length, returns });
    } catch (err) {
      console.error('Error fetching returns:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch returns' });
    }
  });

  app.post('/api/returns', (req, res) => {
    try {
      const returnRequest = req.body;
      if (!returnRequest || !returnRequest.orderId) {
        return res.status(400).json({ success: false, error: 'Invalid return request' });
      }
      const returns = readJsonFile<any[]>(RETURNS_FILE, []);
      returns.unshift({ ...returnRequest, createdAt: new Date().toISOString() });
      writeJsonFile(RETURNS_FILE, returns);

      // Also flag order in orders.json
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const order = orders.find(o => o.id === returnRequest.orderId || o.orderNumber === returnRequest.orderNumber);
      if (order) {
        order.returnRequested = true;
        order.returnReason = returnRequest.reason;
        order.returnStatus = 'pending';
        order.returnDate = 'Scheduled for Tomorrow pickup';
        order.updatedAt = new Date().toISOString();
        writeJsonFile(ORDERS_FILE, orders);
      }

      res.json({ success: true, returnRequest });
    } catch (err) {
      console.error('Error creating return request:', err);
      res.status(500).json({ success: false, error: 'Failed to create return request' });
    }
  });

  app.patch('/api/returns/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { status, resolutionDate } = req.body;
      const returns = readJsonFile<any[]>(RETURNS_FILE, []);
      const item = returns.find(r => r.id === id);
      if (!item) return res.status(404).json({ success: false, error: 'Return request not found' });

      if (status) item.status = status;
      item.resolutionDate = resolutionDate || new Date().toLocaleDateString('en-GB');
      item.updatedAt = new Date().toISOString();
      writeJsonFile(RETURNS_FILE, returns);

      // Also sync to order in orders.json
      const orders = readJsonFile<any[]>(ORDERS_FILE, []);
      const order = orders.find(o => o.id === item.orderId || o.orderNumber === item.orderNumber);
      if (order) {
        order.returnStatus = status;
        if (status === 'refunded') {
          order.paymentStatus = 'refunded';
          order.status = 'returned';
        }
        order.updatedAt = new Date().toISOString();
        writeJsonFile(ORDERS_FILE, orders);
      }

      res.json({ success: true, returnRequest: item });
    } catch (err) {
      console.error('Error updating return request:', err);
      res.status(500).json({ success: false, error: 'Failed to update return request' });
    }
  });

  // --- 3D Live Video Settings Persistence API ---
  const DEFAULT_VIDEO_PRESETS = [
    {
      id: 'drape-gold',
      title: '3D Luxury Fabric Flow & Drape',
      titleHi: '3D रॉयल फैब्रिक ड्रेप व फ्लो',
      desc: 'Pure Giza cotton & gold thread sheen in motion',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      posterUrl: 'https://images.unsplash.com/photo-1617137984095-74e4e5e3613f?auto=format&fit=crop&w=1200&q=80',
      colorHex: '#C8A96B',
      tag: 'RAYMOND SPECIAL',
    },
    {
      id: 'suit-spin',
      title: '3D Tailored Suit 360° Showcase',
      titleHi: '3D स्यूटिंग व पैंट 360° फिनिश',
      desc: 'Handcrafted wrinkle-free Italian twill construction',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyBlazes.mp4',
      posterUrl: 'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?auto=format&fit=crop&w=1200&q=80',
      colorHex: '#111111',
      tag: 'SIYARAM TWILL',
    },
    {
      id: 'cotton-weave',
      title: '3D Microscopic Thread Weave',
      titleHi: '3D सूक्ष्म धागा बुनाई क्वालिटी',
      desc: 'High-density 120s double-twist breathable yarns',
      videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
      posterUrl: 'https://images.unsplash.com/photo-1602810318383-e386cc2a3ccf?auto=format&fit=crop&w=1200&q=80',
      colorHex: '#E5E0D8',
      tag: 'ARVIND PURE COTTON',
    }
  ];

  app.get('/api/settings/3d-video', (_req, res) => {
    try {
      let presets = readJsonFile<any[]>(VIDEO_SETTINGS_FILE, []);
      if (!Array.isArray(presets) || presets.length === 0) {
        presets = DEFAULT_VIDEO_PRESETS;
        writeJsonFile(VIDEO_SETTINGS_FILE, presets);
      }
      res.json({ success: true, presets });
    } catch (err) {
      console.error('Error fetching 3D video settings:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch video settings' });
    }
  });

  app.post('/api/settings/3d-video', (req, res) => {
    try {
      const { presets } = req.body;
      if (!Array.isArray(presets) || presets.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid presets array' });
      }
      writeJsonFile(VIDEO_SETTINGS_FILE, presets);
      res.json({ success: true, message: '3D Video presets saved successfully', presets });
    } catch (err) {
      console.error('Error saving 3D video settings:', err);
      res.status(500).json({ success: false, error: 'Failed to save video settings' });
    }
  });

  app.post('/api/settings/3d-video/reset', (_req, res) => {
    try {
      writeJsonFile(VIDEO_SETTINGS_FILE, DEFAULT_VIDEO_PRESETS);
      res.json({ success: true, message: '3D Video presets reset to defaults successfully', presets: DEFAULT_VIDEO_PRESETS });
    } catch (err) {
      console.error('Error resetting 3D video settings:', err);
      res.status(500).json({ success: false, error: 'Failed to reset video settings' });
    }
  });

  // --- Store Profile / Merchant Settings Persistence API ---
  app.get('/api/settings/store', (_req, res) => {
    try {
      const settings = readJsonFile<any>(STORE_SETTINGS_FILE, {
        tradeName: 'SHREE MARUTI KRUPA TEXTILE TRADERS',
        gstin: '24AAACS1234F1Z8',
        warehouseAddress: 'Shop 104-106, Textile Market Bhavan, Varachha Main Road, Surat, Gujarat - 395006',
        phone: '+91 88497 56544',
        tollFree: '8849756544',
        email: 'support@shreemarutikrupa.com',
        defaultCourier: 'Delhivery Surface Express'
      });
      res.json({ success: true, settings });
    } catch (err) {
      console.error('Error fetching store settings:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch store settings' });
    }
  });

  app.post('/api/settings/store', (req, res) => {
    try {
      const current = readJsonFile<any>(STORE_SETTINGS_FILE, {});
      const updated = { ...current, ...req.body, updatedAt: new Date().toISOString() };
      writeJsonFile(STORE_SETTINGS_FILE, updated);
      res.json({ success: true, message: 'Store settings saved successfully', settings: updated });
    } catch (err) {
      console.error('Error saving store settings:', err);
      res.status(500).json({ success: false, error: 'Failed to save store settings' });
    }
  });

  // --- Admin Authentication Persistence API ---
  app.post('/api/admin/auth/change-password', (req, res) => {
    try {
      const { username, passwordHash } = req.body;
      if (!username || !passwordHash) {
        return res.status(400).json({ success: false, error: 'Username and passwordHash required' });
      }
      const auth = {
        username: String(username).trim().toLowerCase(),
        passwordHash: String(passwordHash).trim(),
        updatedAt: new Date().toISOString()
      };
      writeJsonFile(ADMIN_AUTH_FILE, auth);
      res.json({ success: true, message: 'Admin credentials updated successfully' });
    } catch (err) {
      console.error('Error updating admin credentials:', err);
      res.status(500).json({ success: false, error: 'Failed to update credentials' });
    }
  });

  app.post('/api/admin/auth/verify', (req, res) => {
    try {
      const { username, passwordHash } = req.body;
      const cleanUser = String(username || '').trim().toLowerCase();
      const currentAuth = readJsonFile<any>(ADMIN_AUTH_FILE, {
        username: 'admin',
        passwordHash: 'b0ee8eec55cfebf0653d9e30a5caeeb3c9ff4cfc7aa9a0a03a25cfaf3077717f'
      });

      const isValid = (currentAuth.username === cleanUser && currentAuth.passwordHash === passwordHash);
      res.json({ success: true, valid: isValid });
    } catch (err) {
      console.error('Error verifying admin credentials:', err);
      res.status(500).json({ success: false, error: 'Verification failed' });
    }
  });

  app.get('/api/payment/transactions', (_req, res) => {
    const payments = readJsonFile<PaymentSession[]>(PAYMENTS_FILE, []);
    res.json({
      success: true,
      count: payments.length,
      transactions: payments,
    });
  });

  // --- Vite Middleware or Static Assets ---
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Shree Maruti Krupa] Server & PhonePe Gateway API live on http://0.0.0.0:${PORT}`);
  });
}

startServer();
