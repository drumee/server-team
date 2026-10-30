// Email classification for MKT offer rules (mkt_coupon.once_per_domain /
// block_disposable, see yp mkt_offer_check).
//
// "One redemption per company domain" cannot apply to free-mail providers:
// gmail.com is not a company, and counting it as one would let exactly one
// Gmail user in the world use the offer. A free-mail address therefore gets
// an empty domain key and is limited per address instead (the existing
// "1 email = 1 deal" rule). Disposable domains are refused outright when the
// coupon asks for it.
//
// Both lists are deliberately local and static: the check runs inside
// checkout, and a lookup service that is slow or down must not block a sale.
// They cover the common providers; a domain missing from them is treated as a
// company domain, which errs on the side of the stricter rule.

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.fr',
  'hotmail.co.uk', 'live.com', 'live.fr', 'msn.com', 'yahoo.com', 'yahoo.fr',
  'yahoo.co.uk', 'yahoo.com.vn', 'ymail.com', 'rocketmail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'gmx.fr', 'web.de', 'mail.com', 'zoho.com',
  'zohomail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', '163.com',
  '126.com', 'naver.com', 'daum.net', 'orange.fr', 'free.fr', 'laposte.net',
  'sfr.fr', 'wanadoo.fr', 'bluewin.ch', 'tutanota.com', 'tuta.io', 'fastmail.com',
  'hey.com', 'seznam.cz', 'libero.it', 'virgilio.it', 'outlook.fr', 'live.co.uk',
]);

const DISPOSABLE = new Set([
  '0-mail.com', '10minutemail.com', '10minutemail.net', '20minutemail.com',
  '33mail.com', 'anonaddy.me', 'burnermail.io', 'byom.de', 'deadaddress.com',
  'discard.email', 'discardmail.com', 'dispostable.com', 'dropmail.me',
  'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'getairmail.com',
  'getnada.com', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de',
  'guerrillamail.info', 'guerrillamail.net', 'guerrillamail.org',
  'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com', 'incognitomail.org',
  'jetable.org', 'mail-temp.com', 'mail.tm', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'mailnesia.com',
  'mailpoof.com', 'mailsac.com', 'mailtemp.net', 'mintemail.com', 'moakt.com',
  'mohmal.com', 'mytemp.email', 'nada.email', 'nowmymail.com', 'one-time.email',
  'sharklasers.com', 'spam4.me', 'spambox.us', 'spamgourmet.com', 'spamex.com',
  'tafmail.com', 'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com',
  'tempmail.com', 'tempmail.dev', 'tempmail.net', 'tempmail.plus', 'tempmailo.com',
  'tempr.email', 'throwawaymail.com', 'trashmail.com', 'trashmail.de',
  'trashmail.net', 'trbvm.com', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
  'emailfake.com', 'fexbox.org', 'grr.la', 'pokemail.net', 'mvrht.net',
  'linshiyouxiang.net', 'mailnull.com', 'mailforspam.com', 'tmail.ws', 'tmpmail.org',
  'tmpmail.net', 'vomoto.com', 'wegwerfmail.de', 'wegwerfmail.net', 'zetmail.com',
  'cool.fr.nf', 'jetable.fr.nf', 'courriel.fr.nf', 'moncourrier.fr.nf',
  'monemail.fr.nf', 'monmail.fr.nf', 'mail.gw', 'inboxkitten.com', 'emltmp.com',
  'tempm.com', 'chacuo.net', 'disposablemail.com', 'easytrashmail.com',
]);

// Domain part of an address, lowercased; '' when there is none.
function emailDomain(email) {
  const at = String(email || '').trim().toLowerCase().lastIndexOf('@');
  return at > 0 ? String(email).trim().toLowerCase().slice(at + 1) : '';
}

// A subdomain of a listed domain counts as that domain
// (x.mailinator.com is still mailinator).
function _listed(set, domain) {
  for (let d = domain; d && d.includes('.'); d = d.slice(d.indexOf('.') + 1)) {
    if (set.has(d)) return true;
  }
  return false;
}

/**
 * @param {string} email
 * @returns {{domain: string, domain_key: string, free: boolean, disposable: boolean}}
 *   domain_key is the company domain the once-per-domain rule compares,
 *   '' for free-mail (and for an address without a domain).
 */
function classifyEmail(email) {
  const domain = emailDomain(email);
  const free = !!domain && _listed(FREE_MAIL, domain);
  const disposable = !!domain && _listed(DISPOSABLE, domain);
  return { domain, domain_key: free || disposable ? '' : domain, free, disposable };
}

module.exports = { classifyEmail };
