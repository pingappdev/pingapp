"use client";
import { useState, useEffect } from "react";
import { ArrowUpRight, Menu, X, Send } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
const slides = [
  {
    label: "We Are PingApp",
    eyebrow: "YOUR NUMBER. YOUR WALLET.",
    title: "Send Crypto\nLike a Text.",
    body: "No address to copy. No QR to scan. Just the phone number you already have, and the wallet you already control.",
    cta: "Open Dashboard",
    href: "/dashboard",
    image: "/assets/pingapp-woman-phone.webp",
  },
  {
    label: "Built Around You",
    eyebrow: "YOUR CONNECTION",
    title: "Familiar Connections.\nA Better Way to Send.",
    body: "One phone number connects you to the wallets you trust. Keep your keys, your funds, and your freedom.",
    cta: "Explore PingApp",
    href: "/what-we-do",
    image: "/assets/pingapp-man-phone.webp",
  },
  {
    label: "The PingApp Perspective",
    eyebrow: "PERSPECTIVES",
    title: "Your Wallet.\nWithout the Friction.",
    body: "A closer look at the directory layer making crypto feel a little more human.",
    cta: "Read the Overview",
    href: "/insights/phone-to-wallet",
    image: "/assets/pingapp-architecture.webp",
  },
];
export default function Marketing({ page = "home" }: { page?: string }) {
  const [headerLight, setHeaderLight] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [feature, setFeature] = useState(0);
  const [slide, setSlide] = useState(0),
    [menu, setMenu] = useState(false),
    [mobile, setMobile] = useState(false),
    [social, setSocial] = useState("");
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => setSlide((s) => (s + 1) % 3), 6500);
    return () => clearTimeout(t);
  }, [slide]);
  useEffect(() => {
    const update = () => {
      setScrolled(window.scrollY > 40);
      const e = document.elementFromPoint(window.innerWidth / 2, 90);
      setHeaderLight(!!e?.closest(".light"));
    };
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
        setMobile(false);
      }
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("keydown", close);
    const leave = () => {
      setMenu(false);
      setMobile(false);
    };
    window.addEventListener("pingapp:navigation-start", leave);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("keydown", close);
      window.removeEventListener("pingapp:navigation-start", leave);
    };
  }, []);
  useEffect(() => {
    const nodes = document.querySelectorAll(".reveal");
    const ob = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add("shown");
        }),
      { threshold: 0.12 },
    );
    nodes.forEach((n) => ob.observe(n));
    return () => ob.disconnect();
  }, [page]);
  return (
    <>
      <header
        className={`site-header ${headerLight && !menu && !mobile ? "light-header" : ""} ${scrolled ? "scrolled" : ""}`}
      >
        <a className="wordmark" href="/">
          PingApp<span>®</span>
        </a>
        <nav>
          <button
            onMouseEnter={() => setMenu(true)}
            onClick={() => setMenu(!menu)}
            aria-expanded={menu}
          >
            What We Do <span>⌄</span>
          </button>
          <a href="/who-we-are" onMouseEnter={() => setMenu(false)}>
            Who We Are
          </a>
          <a href="/case-studies" onMouseEnter={() => setMenu(false)}>
            Use Cases
          </a>
          <a href="/insights" onMouseEnter={() => setMenu(false)}>
            Insights
          </a>
        </nav>
        <a className="button small" href="/dashboard">
          Open App <ArrowUpRight size={15} />
        </a>
        <button className="mobile-toggle" aria-label="Open menu" onClick={() => setMobile(!mobile)}>
          {mobile ? <X /> : <Menu />}
        </button>
      </header>
      {(menu || mobile) && (
        <div className="mega-menu" onMouseLeave={() => setMenu(false)}>
          <span className="eyebrow">WHAT WE DO</span>
          <div>
            <a href="/what-we-do/resolve">Phone-to-Wallet</a>
            <a href="/what-we-do/connect">Wallet Connection</a>
            <a href="/what-we-do/security">Security</a>
            {mobile && (
              <>
                <a href="/who-we-are">Who We Are</a>
                <a href="/case-studies">Use Cases</a>
                <a href="/insights">Insights</a>
              </>
            )}
          </div>
          <a className="menu-feature" href="/what-we-do">
            <img src="/assets/pingapp-banner-3x1.png" alt="PingApp violet and red identity" />
            <small>Overview</small>
            <p>Discover a simpler way to connect.</p>
          </a>
        </div>
      )}
      <main>
        {page === "home" ? (
          <>
            <section className="hero" onMouseEnter={() => setMenu(false)}>
              {slides.map((s, i) => (
                <div
                  key={s.label}
                  className={`hero-slide ${slide === i ? "active" : ""}`}
                  aria-hidden={slide !== i}
                >
                  <div className="hero-image" style={{ backgroundImage: `url(${s.image})` }} />
                  <div className="hero-shade" />
                  <div className="hero-copy">
                    <p className="eyebrow">{s.eyebrow}</p>
                    <h1>
                      {s.title.split("\n").map((t, j) => (
                        <span key={j}>
                          {t}
                          <br />
                        </span>
                      ))}
                    </h1>
                    <p>{s.body}</p>
                    <a className="button" href={s.href} tabIndex={slide === i ? 0 : -1}>
                      {s.cta}
                      <ArrowUpRight size={16} />
                    </a>
                  </div>
                </div>
              ))}
              <div className="hero-tabs">
                {slides.map((s, i) => (
                  <button
                    key={s.label}
                    onClick={() => setSlide(i)}
                    className={slide === i ? "selected" : ""}
                  >
                    <span>{s.label}</span>
                    <span className="slide-number">0{i + 1}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="intro light section">
              <div className="section-rule eyebrow">ABOUT PINGAPP</div>
              <p className="intro-statement reveal">
                The wallet address was never the point.
                <br />
                <span>The person on the other end was.</span>
                <br />
                PingApp connects the number you know to the wallet they control.
              </p>
              <div className="intro-bottom">
                <p>
                  Crypto already connects us. PingApp makes it feel that way. A phone-to-wallet
                  directory built around familiar contacts, clear confirmations, and complete
                  ownership.
                </p>
                <a className="text-link" href="/who-we-are">
                  Get to know PingApp <ArrowUpRight size={17} />
                </a>
              </div>
            </section>
            <section className="expertise section">
              <p className="eyebrow reveal">THE CONNECTION LAYER</p>
              <h2 className="reveal">
                Everyday Simplicity.
                <br />
                Wallet-Level Control.
              </h2>
              <div className="section-description">
                <p>
                  From finding a friend to checking your holdings, everything starts with a
                  connection you already have.
                </p>
                <a className="button" href="/dashboard">
                  Make a Connection <ArrowUpRight size={16} />
                </a>
              </div>
              <div className="card-grid">
                {services.map((s, i) => (
                  <a className="service-card reveal" href={s.href} key={s.title}>
                    <div className="image-wrap">
                      <img src={s.image} alt={s.alt} />
                      <span className="image-arrow">
                        <ArrowUpRight />
                      </span>
                    </div>
                    <div className="card-label">
                      <h3>{s.title}</h3>
                      <ArrowUpRight size={19} />
                    </div>
                    <p>{s.short}</p>
                  </a>
                ))}
              </div>
            </section>
            <section className="difference light section">
              <div className="split-heading">
                <h2 className="reveal">
                  The App That
                  <br />
                  Works Differently.
                </h2>
                <div>
                  <p>
                    Your wallet stays yours. PingApp adds the connection, so you can focus on the
                    person, not the address.
                  </p>
                  <a className="button dark" href="/what-we-do">
                    Explore PingApp <ArrowUpRight size={16} />
                  </a>
                </div>
              </div>
              <div className="difference-grid">
                <div className="feature-list">
                  {features.map((f, i) => (
                    <button
                      key={f.title}
                      onClick={() => setFeature(i)}
                      onMouseEnter={() => setFeature(i)}
                      aria-expanded={feature === i}
                      className={feature === i ? "active" : ""}
                    >
                      <span>{f.title}</span>
                      <span className="feature-sign">{feature === i ? "−" : "+"}</span>
                      <p>{f.body}</p>
                    </button>
                  ))}
                </div>
                <a className="stat-image" href={services[feature].href}>
                  <img src={services[feature].image} alt={services[feature].alt} />
                  <div className="stat-overlay">
                    <span>BUILT FOR YOU</span>
                    <div>
                      <strong>{["01", "01", "100%"][feature]}</strong>
                      <small>{["FAMILIAR NUMBER", "ROBINHOOD CHAIN", "YOUR KEYS"][feature]}</small>
                    </div>
                  </div>
                </a>
              </div>
            </section>
            <section className="story-panel">
              <img
                src="/assets/pingapp-woman-phone.webp"
                alt="A person staying connected through their phone"
              />
              <div className="story-shade" />
              <div className="story-copy reveal">
                <p className="eyebrow">OWNERSHIP, WITHOUT COMPROMISE</p>
                <blockquote>
                  “No address to copy. No QR to scan. Just the phone number you already have, and
                  the wallet you already control.”
                </blockquote>
                <p>THE PINGAPP PRINCIPLE</p>
              </div>
              <div className="story-stats">
                <div>
                  <span>PRIVATE KEYS HELD BY PINGAPP</span>
                  <strong>0</strong>
                </div>
                <div>
                  <span>SUPPORTED NETWORK</span>
                  <strong>1</strong>
                </div>
              </div>
            </section>
            <section className="insights light section">
              <div className="section-rule eyebrow">THE PERSPECTIVE</div>
              <div className="section-description">
                <h2>Insights</h2>
                <a className="text-link" href="/insights">
                  All Insights <ArrowUpRight size={16} />
                </a>
              </div>
              <ArticleCards />
            </section>
          </>
        ) : (
          <InnerPage page={page} />
        )}
      </main>
      <footer className="footer section">
        <div className="footer-top">
          <h3>Make Your Next Connection.</h3>
          <a className="button" href="/dashboard">
            Open PingApp <ArrowUpRight size={16} />
          </a>
        </div>
        <div className="footer-columns">
          <div>
            <p className="eyebrow">MENU</p>
            <a href="/">Home</a>
            <a href="/what-we-do">What We Do</a>
            <a href="/who-we-are">Who We Are</a>
            <a href="/case-studies">Use Cases</a>
            <a href="/insights">Insights</a>
          </div>
          <div>
            <p className="eyebrow">CONNECT</p>
            <a href="/contact">Contact Us</a>
            <div className="socials">
              <button aria-label="X" onClick={() => setSocial("X")}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.4l7.8-9L.8 2h6.5l5.3 7.1L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z" />
                </svg>
              </button>
              <button aria-label="GitHub" onClick={() => setSocial("GitHub")}>
                <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.52-1.3-1.27-1.65-1.27-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.69.12 2.98.72.79 1.15 1.79 1.15 3.02 0 4.32-2.64 5.27-5.15 5.55.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.78.54A11.2 11.2 0 0 0 12 .8Z" />
                </svg>
              </button>
              <button aria-label="Telegram" onClick={() => setSocial("Telegram")}>
                <Send size={19} />
              </button>
            </div>
          </div>
          <div>
            <p className="eyebrow">LEGAL</p>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div>
            <a className="wordmark" href="/">
              PingApp<span>®</span>
            </a>
            <p>Your number. Your wallet.</p>
          </div>
          <small>© {new Date().getFullYear()} PingApp</small>
        </div>
      </footer>
      <Dialog open={!!social} onOpenChange={() => setSocial("")}>
        <DialogContent>
          <DialogTitle>Coming soon</DialogTitle>
          <DialogDescription>
            PingApp on {social}. Our next connection is on its way.
          </DialogDescription>
        </DialogContent>
      </Dialog>
    </>
  );
}
const services = [
  {
    title: "Phone-to-Wallet",
    short: "Familiar numbers. Clear destinations.",
    href: "/what-we-do/resolve",
    image: "/assets/pingapp-man-phone.webp",
    alt: "A man checking his phone in a sunlit office",
  },
  {
    title: "Wallet Connection",
    short: "Your assets, right where they belong.",
    href: "/what-we-do/connect",
    image: "/assets/pingapp-architecture.webp",
    alt: "Modern architecture in violet and crimson light",
  },
  {
    title: "Security",
    short: "Control stays with you.",
    href: "/what-we-do/security",
    image: "/assets/pingapp-woman-phone.webp",
    alt: "A woman using her phone outside a glass building",
  },
];
const features = [
  {
    title: "We Connect the Familiar",
    body: "A verified phone number points to the wallet its owner linked. Review their name, full address, and any warnings before approving in your own wallet.",
  },
  {
    title: "We Work With Your Wallet",
    body: "Connect your wallet and sign one message. No email, no password, no seed phrase. See ETH, USDG and Robinhood Stock Tokens on Robinhood Chain, with no need to move your assets.",
  },
  {
    title: "We Leave You in Control",
    body: "PingApp never asks for a seed phrase. Every transfer requires approval in your own wallet. You can disconnect at any time.",
  },
];
const articles = [
  {
    slug: "phone-to-wallet",
    title: "A More Human Way to Send Crypto",
    description: "Why the missing layer is a familiar connection, not another wallet.",
    image: "/assets/pingapp-architecture.webp",
    tag: "PRODUCT",
  },
  {
    slug: "your-keys",
    title: "Your Keys. Your Wallet. Your Choice.",
    description: "What non-custodial means when the connection layer never holds your funds.",
    image: "/assets/pingapp-man-phone.webp",
    tag: "OWNERSHIP",
  },
  {
    slug: "safer-connections",
    title: "The Destination Deserves a Second Look",
    description:
      "Phone numbers can change. A thoughtful connection starts with a clear confirmation.",
    image: "/assets/pingapp-woman-phone.webp",
    tag: "SECURITY",
  },
];
function ArticleCards() {
  return (
    <div className="card-grid">
      {articles.map((a) => (
        <a className="article-card reveal" href={"/insights/" + a.slug} key={a.slug}>
          <div className="image-wrap">
            <img src={a.image} alt="" />
            <span className="image-arrow">
              <ArrowUpRight />
            </span>
          </div>
          <small>{a.tag} · 4 MIN READ</small>
          <h3>{a.title}</h3>
          <p>{a.description}</p>
        </a>
      ))}
    </div>
  );
}
const articlesBody: Record<string, Array<[string, string]>> = {
  "phone-to-wallet": [
    [
      "Start with who, not where",
      "Most of us remember people through their names and phone numbers. A wallet address is useful to a network, but it is not how people naturally connect. PingApp is designed to bridge that gap.",
    ],
    [
      "A directory, not a destination",
      "Phone-to-wallet sending resolves a verified number to the wallet its owner linked. Your wallet remains the place where you hold assets and approve transactions.",
    ],
    [
      "Always review the destination",
      "A familiar number is a useful starting point, not a guarantee. Check the name, full address, and warnings before approving a transfer. The On PingApp badge means the contact's number is verified and linked to a wallet; your address book stays private.",
    ],
    [
      "Built on Robinhood Chain",
      "Send ETH, USDG and Robinhood Stock Tokens on Robinhood Chain. The recipient must use the same network; assets on other networks are separate.",
    ],
    [
      "Invite someone new",
      "Friend not on PingApp yet? Create a pending send. Nothing leaves your wallet; we text them an invite and let you know when they're ready. You then review and approve the transfer in your wallet.",
    ],
  ],
  "your-keys": [
    [
      "Ownership starts with the keys",
      "A non-custodial experience leaves control of funds with the wallet owner. PingApp does not collect private keys or seed phrases.",
    ],
    [
      "Connection is not permission to spend",
      "Connecting a wallet reveals its public address. Each transfer is a separate request that you review and approve in that wallet. Closing PingApp does not move or lock your funds.",
    ],
    [
      "Read directly from the chain",
      "After you sign in, the dashboard reads your wallet's Robinhood Chain balances through RPC providers. Signing in does not grant permission to spend; every transfer needs your separate wallet approval.",
    ],
    [
      "The boundaries matter",
      "PingApp cannot reverse a transfer, recover a lost seed phrase, or freeze assets. Those limits follow from leaving ownership with you.",
    ],
  ],
  "safer-connections": [
    [
      "Numbers can change hands",
      "A phone number is a convenient identifier, but it is not a permanent cryptographic identity. A number can be reassigned or affected by a SIM swap.",
    ],
    [
      "Pause before a changed destination",
      "A changed wallet mapping deserves an explicit warning and an opportunity to confirm the recipient through another trusted channel.",
    ],
    [
      "Verified links and manual review",
      "Verify your number with a one-time SMS code. Your number is stored encrypted and is only used to route transfers to your wallet. A number already linked to another wallet cannot be silently moved: a competing claim goes through manual review. Phone verification does not protect against every SIM swap, so confirm uncertain recipients directly.",
    ],
    [
      "Check what you approve",
      "Read the network, full destination, and amount in your wallet. Send only after you are satisfied that all three match your intention.",
    ],
  ],
};
function InnerPage({ page }: { page: string }) {
  const article = articles.find((a) => "insights/" + a.slug === page);
  if (article)
    return (
      <>
        <section className="article-hero section">
          <a className="text-link" href="/insights">
            ← All Insights
          </a>
          <p className="eyebrow">{article.tag}</p>
          <h1>{article.title}</h1>
          <p>{article.description}</p>
        </section>
        <img className="article-cover" src={article.image} alt="" />
        <article className="article-body light section">
          {articlesBody[article.slug].map(([h, p]) => (
            <section key={h}>
              <h2>{h}</h2>
              <p>{p}</p>
            </section>
          ))}
        </article>
      </>
    );
  if (page === "privacy" || page === "terms")
    return (
      <section className="legal light section">
        <p className="eyebrow">PINGAPP</p>
        <h1>{page === "privacy" ? "Privacy" : "Terms of Use"}</h1>
        {(page === "privacy"
          ? [
              [
                "Your workspace",
                "Your signed-in account is used to keep your contact book, saved wallet address, preferences, and activity separate from other users.",
              ],
              [
                "What is stored",
                "Saved contacts contain the name, phone number, and wallet address you enter. Your public wallet address and submitted transaction hashes may also be stored. Private keys and seed phrases are never requested or stored.",
              ],
              [
                "Network requests",
                "Reading balances sends public wallet addresses to blockchain RPC providers. Transfers are submitted through your connected wallet. No SMS verification provider is connected to this workspace.",
              ],
              [
                "Your controls",
                "You can remove contacts, disconnect your wallet, and update account preferences in the dashboard. Disconnecting a wallet does not delete public blockchain records.",
              ],
            ]
          : [
              [
                "Your wallet remains yours",
                "You control your keys and authorize transactions in your own wallet. PingApp cannot recover assets or reverse blockchain transactions.",
              ],
              [
                "Review every transfer",
                "You are responsible for verifying the recipient address, network, amount, and fees before approving a transaction. Saved phone contacts are not proof of ownership of a number.",
              ],
              [
                "Service availability",
                "Network and third-party wallet services may be unavailable. Phone verification and public number resolution require connected services and are unavailable until configured.",
              ],
              [
                "Supported networks",
                "The dashboard supports EVM addresses on Robinhood Chain, Ethereum, and Arbitrum. Do not use non-EVM addresses or send on unsupported networks.",
              ],
            ]
        ).map(([h, p]) => (
          <section key={h}>
            <h2>{h}</h2>
            <p>{p}</p>
          </section>
        ))}
      </section>
    );
  if (page === "contact")
    return (
      <section className="contact-page section">
        <p className="eyebrow">LET’S CONNECT</p>
        <h1>
          Your Next Connection
          <br />
          Starts Here.
        </h1>
        <p>
          Open your workspace to connect a wallet, organise your contacts, and keep track of your
          transfers.
        </p>
        <a className="button" href="/dashboard">
          Open Dashboard <ArrowUpRight size={16} />
        </a>
        <div className="contact-links">
          <a href="/what-we-do">
            Explore the product <ArrowUpRight />
          </a>
          <a href="/insights/safer-connections">
            Understand the security model <ArrowUpRight />
          </a>
        </div>
      </section>
    );
  if (page === "insights")
    return (
      <section className="inner-index light section">
        <p className="eyebrow">THE PERSPECTIVE</p>
        <h1>
          Ideas for a More
          <br />
          Connected World.
        </h1>
        <p className="index-intro">
          The thinking behind simpler connections, transparent ownership, and thoughtful security.
        </p>
        <ArticleCards />
      </section>
    );
  if (page === "case-studies")
    return (
      <>
        <section className="inner-index light section">
          <p className="eyebrow">USE CASES</p>
          <h1>
            Familiar Connections.
            <br />
            Everyday Possibilities.
          </h1>
          <p className="index-intro">
            For people who want their wallet to fit the way they already connect.
          </p>
          <a className="button dark" href="/dashboard">
            Open PingApp <ArrowUpRight size={16} />
          </a>
          <div className="network-marquee">
            <div>
              {Array.from({ length: 3 }, (_, j) =>
                [
                  "Robinhood Chain",
                  "Stock Tokens",
                  "MetaMask",
                  "Rabby",
                  "Coinbase Wallet",
                  "WalletConnect",
                ].map((n) => <span key={j + n}>{n}</span>),
              )}
            </div>
          </div>
        </section>
        <section className="light section use-cases">
          {[
            [
              "Send to Someone You Know",
              "Keep a personal contact book with familiar names and reviewed wallet addresses. Open a contact and prepare your transfer in a few steps.",
            ],
            [
              "Keep Your Portfolio Close",
              "See ETH, USDG and Robinhood Stock Tokens on Robinhood Chain, with balances and USD values in one place. Your assets stay in your wallet.",
            ],
            [
              "Follow Every Connection",
              "Review transfer hashes, open the blockchain explorer, and export your activity whenever you need a record.",
            ],
          ].map(([h, p], i) => (
            <a
              className="case-row reveal"
              href={"/dashboard" + ["/contacts", "", "/activity"][i]}
              key={h}
            >
              <img src={services[i].image} alt="" />
              <div>
                <p className="eyebrow">0{i + 1} / EVERYDAY PINGAPP</p>
                <h2>{h}</h2>
                <p>{p}</p>
                <span className="text-link">
                  Explore your workspace <ArrowUpRight size={18} />
                </span>
              </div>
            </a>
          ))}
        </section>
      </>
    );
  if (page === "who-we-are")
    return (
      <>
        <section className="about-title section">
          <p className="eyebrow">OUR PURPOSE</p>
          <h1>
            We Believe Sending Crypto
            <br />
            Should Start With a Person,
            <br />
            Not a String of Characters.
          </h1>
        </section>
        <div className="about-images">
          <img src="/assets/pingapp-man-phone.webp" alt="A person connecting from their office" />
          <img src="/assets/pingapp-woman-phone.webp" alt="A person connecting on the go" />
        </div>
        <section className="light section">
          <div className="split-heading">
            <h2>
              A Directory Layer.
              <br />A Human Connection.
            </h2>
            <div>
              <p>
                PingApp connects the phone number you already have to the wallet you already
                control. The goal is simple: reduce the friction between people without taking
                ownership of their money.
              </p>
              <p>
                Every account can send and receive. There is no protocol token, no migration to a
                new wallet, and no custody of your funds.
              </p>
            </div>
          </div>
          <div className="principles">
            {features.map((f, i) => (
              <div className="reveal" key={f.title}>
                <span>0{i + 1}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </>
    );
  const i = page.endsWith("resolve") ? 0 : page.endsWith("connect") ? 1 : 2;
  const service = services[i];
  const overview = page === "what-we-do";
  return (
    <>
      <section className="service-title section">
        <p className="eyebrow">{overview ? "WHAT WE DO" : "PINGAPP / PRODUCT"}</p>
        <div>
          <h1>{overview ? "A Better Way to Connect." : service.title}</h1>
          <p>{overview ? "Simple on the surface. Ownership at the centre." : service.short}</p>
        </div>
      </section>
      <div className="service-cover">
        <img src={overview ? "/assets/pingapp-man-phone.webp" : service.image} alt={service.alt} />
      </div>
      <section className="light section">
        <div className="split-heading">
          <h2>
            {overview
              ? "Built Around\nYour Connections."
              : [
                  "Know Where\nYour Crypto Goes.",
                  "The Wallet You Trust.\nOn Robinhood Chain.",
                  "A Thoughtful Pause.\nA Clear Confirmation.",
                ][i]}
          </h2>
          <div>
            <p>
              {overview
                ? "A familiar directory, your own wallet, and the information you need before every transfer."
                : features[i].body}
            </p>
            <a className="button dark" href="/dashboard">
              Open Your Dashboard <ArrowUpRight size={16} />
            </a>
          </div>
        </div>
        <div className="principles">
          {(overview
            ? features
            : i === 0
              ? [
                  {
                    title: "Verify Your Number",
                    body: "Verify your number with a one-time SMS code. Your number is stored encrypted and is only used to route transfers to your wallet.",
                  },
                  {
                    title: "Review the Destination",
                    body: "A verified number resolves to its owner's linked wallet. Check the name, full address and warnings before continuing.",
                  },
                  {
                    title: "Approve in Your Wallet",
                    body: "Your wallet presents the final request. You decide whether to send.",
                  },
                  {
                    title: "Invite Someone New",
                    body: "Friend not on PingApp yet? Create a pending send. Nothing leaves your wallet; we text them an invite and let you know when they're ready.",
                  },
                ]
              : i === 1
                ? [
                    {
                      title: "Robinhood Chain",
                      body: "See ETH, USDG and Robinhood Stock Tokens on Robinhood Chain. Approve each transfer in your own wallet.",
                    },
                    {
                      title: "Stock Tokens",
                      body: "Send tokenized stocks like any other token, straight from your wallet. Availability and transfer eligibility are set by the issuer.",
                    },
                  ]
                : [
                    {
                      title: "No Seed Phrases",
                      body: "PingApp never asks you to enter a private key or recovery phrase.",
                    },
                    {
                      title: "Explicit Approval",
                      body: "Every transaction is reviewed and signed inside your own wallet.",
                    },
                    {
                      title: "Manual Review",
                      body: "Numbers already linked cannot be silently moved to another wallet. Competing claims go through manual review. Numbers can still be reassigned or SIM-swapped: confirm the recipient and full address before sending.",
                    },
                  ]
          ).map((f, j) => (
            <div className="reveal" key={f.title}>
              <span>0{j + 1}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
