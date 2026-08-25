/**
 * MockLab demo site — a fake airline trip card.
 *
 * This page is the acceptance harness for every milestone (PLAN.md §14). It is
 * deliberately built so that the rendered UI can NOT be derived from the data by
 * string matching alone:
 *
 *   - status  -> pill text AND colour AND a banner   (enum -> presentation mapping,
 *                                                     one field, three visible effects)
 *   - price.total -> three money rows                (fare and taxes are computed here,
 *                                                     so only the total matches verbatim)
 *   - departsAt/arrivesAt -> "12:40"                 (formatted from ISO, derived)
 *   - the tip box                                    (changes on every load = noise)
 *
 * trip.json is fetched with fetch(); user.json is fetched with XMLHttpRequest, so the
 * demo exercises both interception paths. See README "Deviations".
 */
(function () {
  'use strict';

  var STATUS_PRESENTATION = {
    ON_TIME:   { label: 'On time',   cls: '',             banner: null },
    DELAYED:   { label: 'Delayed',   cls: 'is-delayed',   banner: 'Your flight is delayed. Check back for a new departure time.' },
    CANCELLED: { label: 'Cancelled', cls: 'is-cancelled', banner: 'Your flight was cancelled' },
    BOARDING:  { label: 'Boarding',  cls: '',             banner: null },
    LANDED:    { label: 'Landed',    cls: '',             banner: null }
  };

  var TIPS = [
    'Online check-in opens 24 hours before departure.',
    'One cabin bag up to 7 kg travels free.',
    'Arrive 90 minutes early for domestic flights.',
    'Members earn double points on weekday flights.',
    'Seats can be changed free of charge until check-in.',
    'Download your boarding pass before you reach the airport.'
  ];

  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  /** ISO timestamp -> "12:40". Rendered in UTC so the page looks the same everywhere. */
  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    var hh = String(d.getUTCHours()).padStart(2, '0');
    var mm = String(d.getUTCMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function formatMoney(amount, currency) {
    var n = Number(amount);
    if (isNaN(n)) return String(amount);
    return currency + ' ' + n.toFixed(2);
  }

  function renderStatus(status) {
    var pill = $('status-pill');
    var banner = $('alert-banner');
    var view = STATUS_PRESENTATION[status] || { label: String(status), cls: '', banner: null };

    pill.textContent = view.label;
    pill.className = view.cls;

    if (view.banner) {
      banner.textContent = view.banner;
      banner.classList.add('is-visible');
    } else {
      banner.textContent = '';
      banner.classList.remove('is-visible');
    }
  }

  function renderPrice(price) {
    var currency = (price && price.currency) || 'SAR';
    var total = Number((price && price.total) || 0);
    var taxRate = Number((price && price.taxRate) || 0);
    // Derived on the front end: only `total` exists verbatim in the response.
    var taxes = total * taxRate / (1 + taxRate);
    var fare = total - taxes;

    setText('price-base', formatMoney(fare, currency));
    setText('price-taxes', formatMoney(taxes, currency));
    setText('price-total', formatMoney(total, currency));
  }

  function renderTrip(data) {
    var flight = data.flight || {};
    var origin = flight.origin || {};
    var destination = flight.destination || {};

    setText('flight-number', flight.number || '');
    setText('flight-ref', (flight.carrier || '') + ' · Booking ' + ((data.booking && data.booking.reference) || ''));

    renderStatus(data.status);

    setText('departs-at', formatTime(flight.departsAt));
    setText('arrives-at', formatTime(flight.arrivesAt));
    setText('origin-code', origin.code || '');
    setText('origin-city', origin.city || '');
    setText('destination-code', destination.code || '');
    setText('destination-city', destination.city || '');

    renderPrice(data.price);
    renderTip(flight.gate || '');
  }

  function renderUser(data) {
    var user = data.user || {};
    setText('passenger-chip', user.displayName || '');
  }

  /**
   * Deliberate noise: this box shows a different tip on every single load, so the
   * probe's control runs (PLAN.md §7.2) must learn to mask it. The gate number is
   * printed alongside so the box still yields value-match candidates — picking it
   * must fail honestly with `probe.tooNoisy`, not produce a false "Verified".
   */
  function renderTip(gate) {
    var seen = Number(sessionStorage.getItem('mocklab-demo-tip') || '0');
    sessionStorage.setItem('mocklab-demo-tip', String(seen + 1));
    var tip = TIPS[seen % TIPS.length];
    $('tip-box').innerHTML = '<b>Gate ' + gate + '</b> · ' + tip;
  }

  function fail(where, err) {
    // Never leave the page in a "…" state: say what happened.
    console.error('[demo] ' + where + ' failed', err);
    var banner = $('alert-banner');
    banner.textContent = 'Could not load your trip. Refresh the page to try again.';
    banner.classList.add('is-visible');
  }

  fetch('./api/trip.json')
    .then(function (r) { return r.json(); })
    .then(renderTrip)
    .catch(function (e) { fail('trip.json', e); });

  var xhr = new XMLHttpRequest();
  xhr.open('GET', './api/user.json');
  xhr.onload = function () {
    try {
      renderUser(JSON.parse(xhr.responseText));
    } catch (e) {
      fail('user.json', e);
    }
  };
  xhr.onerror = function () { fail('user.json', 'network'); };
  xhr.send();
})();
