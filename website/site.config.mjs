/**
 * The facts the website is built from.
 *
 * Kept apart from the page templates so the things that change for business
 * reasons — a price, the payment link, the Store listing going live — are
 * changed in one obvious place, by someone who does not need to read HTML.
 * After any change, run `npm run website:build` and upload `dist/website/`
 * again (see website/README.md).
 *
 * Product claims do not live here. They are in the page templates, next to
 * the comment that says which part of the code backs them.
 */

/**
 * @typedef {object} Edition
 * @property {'free' | 'professional' | 'business' | 'technician' | 'enterprise'} id
 *   Matches `LICENSE_EDITIONS` in src/shared/constants/app.ts.
 * @property {string} name
 * @property {number | null} priceInr Per year, in whole rupees. `null`: priced on request.
 * @property {string} computers How many PCs one licence covers, as a customer reads it.
 * @property {string} use Who the edition is for, in a few words.
 * @property {string} tagline The one line under a paid edition's name on its
 *   pricing card, as a full sentence.
 * @property {string[]} features What the licence gives, for the /buy/ cards.
 * @property {boolean} selfServiceMoves
 *   Whether the self-service move allowance applies. Licences with unlimited
 *   PCs are never limited by it (see `selfReleaseStanding` in
 *   src/server/authority.ts), so for them it is not worth mentioning.
 */

/**
 * @typedef {object} SiteConfig
 * @property {string} origin Scheme and host, no trailing slash.
 * @property {string} productName
 * @property {{ legalName: string, shortName: string, address: string[], town: string, url: string }} vendor
 *   `town` is what the footer shows; the full `address` is on /support/.
 * @property {string} email Sales, support, privacy and licensing — one mailbox.
 * @property {number} copyrightYear
 * @property {string | null} paymentLinkUrl
 * @property {string | null} storeUrl
 * @property {boolean} installerCodeSigned
 * @property {{ limit: number, windowDays: number }} moveAllowance
 * @property {Edition[]} editions
 */

/** @type {SiteConfig} */
export const site = {
  origin: 'https://recoverx.snapkio.com',
  productName: 'RecoverX',

  vendor: {
    legalName: 'Appsgain Technologies Private Limited',
    shortName: 'Appsgain Technologies',
    address: [
      '22, Appsgain Technologies Building',
      'Goraul Block, Katarmala Road, Adampur',
      'Hajipur, Vaishali, Bihar 844114',
      'India',
    ],
    town: 'Hajipur, Bihar, India',
    url: 'https://appsgain.in',
  },

  email: 'info@appsgain.in',
  copyrightYear: 2026,

  // --- PAYMENT LINK — placeholder ---------------------------------------
  // Set this to the Razorpay / UPI payment link (an https:// URL) once it
  // exists. While it is `null` the site sells by email only, and no "Pay
  // online" button is shown anywhere. The link is opened in the customer's
  // browser from /buy/ — never from inside the app or its installer (Store
  // Policy 10.8.2).
  paymentLinkUrl: null,

  // --- MICROSOFT STORE LISTING ---------------------------------------------
  // The Store page's https:// URL once Partner Center publishes it (for
  // example https://apps.microsoft.com/detail/<product id>). While `null`, the
  // site says "Coming soon to the Microsoft Store" instead of linking to it.
  storeUrl: null,

  // --- CODE SIGNING ----------------------------------------------------------
  // `false` while the published installer is not Authenticode-signed (1.0.0
  // ships unsigned until the OV certificate arrives). /download/ then tells
  // visitors plainly that Windows SmartScreen may warn, and how to verify the
  // file. Set to `true` when a signed installer replaces it.
  installerCodeSigned: false,

  // The default self-service cap on moving a licence between computers:
  // LICENSE_SELF_RELEASE_LIMIT moves in LICENSE_SELF_RELEASE_WINDOW_DAYS, as
  // the licence server is configured (src/server/config.ts, and the PHP port).
  // Change both together.
  moveAllowance: { limit: 4, windowDays: 365 },

  // Approved pricing, 12 November 2026. Seats match ENTITLEMENTS in
  // src/shared/types/license.ts; commercial use matches `commercialUse`.
  editions: [
    {
      id: 'free',
      name: 'Free',
      priceInr: 0,
      computers: '1 PC',
      use: 'Try it, or recover a few files',
      tagline: 'Try it, or recover a few files.',
      features: [
        'Every feature: scanning, preview, drive health',
        'Recover up to 1 GB of files in total',
        'No licence key and no account',
      ],
      selfServiceMoves: false,
    },
    {
      id: 'professional',
      name: 'Professional',
      priceInr: 2499,
      computers: '1 PC',
      use: 'Personal, non-commercial use',
      tagline: 'For your own personal files.',
      features: ['Unlimited recovery', 'One computer at a time', 'For your own personal files'],
      selfServiceMoves: true,
    },
    {
      id: 'business',
      name: 'Business',
      priceInr: 5999,
      computers: '3 PCs',
      use: 'Use inside one organisation',
      tagline: 'Commercial use inside one organisation.',
      features: [
        'Unlimited recovery',
        'Up to three computers at a time',
        'Commercial use within your organisation',
      ],
      selfServiceMoves: true,
    },
    {
      id: 'technician',
      name: 'Technician',
      priceInr: 14999,
      computers: 'Unlimited PCs',
      use: "Recovering data on customers' computers",
      tagline: 'Recovery work on customers’ PCs.',
      features: [
        'Unlimited recovery',
        'Any number of computers',
        'Service use for your clients, on their PCs',
      ],
      selfServiceMoves: false,
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      priceInr: null,
      computers: 'Unlimited PCs',
      use: 'Volume licensing under a separate agreement',
      tagline: 'Volume licensing by agreement.',
      features: [
        'Unlimited recovery',
        'Any number of computers',
        'Terms agreed with your organisation',
      ],
      selfServiceMoves: false,
    },
  ],
}
