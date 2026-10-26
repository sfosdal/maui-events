import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTicketWeb, ticketWebId } from './ticketweb.mjs';

// fixtures in the page's own form: flight data inside a JS string, quotes escaped
const esc = (s) => s.replace(/"/g, '\\"');
const page = (statusName, onSaleTime, eventSections) => `<html><script>self.__next_f.push([1,"a:[{${esc(`"eventDetails":{"status":{"dates":{"onSaleTime":"${onSaleTime}"},"message":null,"messageTitle":null,"name":"${statusName}"},"venueCapacity":0},"eventSections":${eventSections},"phoneUser":false`)}}]\\n"])</script></html>`;
const section = (name, level, soldOut = false) => `{"availabilityType":null,"name":"${name}","prices":[{"name":"${name}","price":"35.65","isSoldOut":${soldOut}}],"sectionId":1,"ismAvailability":"${level}","isSoldOut":${soldOut}}`;

test('ticketWebId reads the numeric id and ignores other hosts', () => {
  assert.equal(ticketWebId('https://www.ticketweb.com/event/kishi-bashi-the-crocodile-tickets/14788903'), '14788903');
  assert.equal(ticketWebId('https://www.ticketweb.com/event/x-tickets/14788903?pl=croc'), '14788903');
  assert.equal(ticketWebId('https://www.ticketmaster.com/event/0F0064C4A03AA22C'), null);
  assert.equal(ticketWebId(''), null);
});

test('an on-sale page with ticket types is available, price from the range, letters not counts', () => {
  const r = readTicketWeb(page('On Sale', '2026-06-09T10:00:00.000-07:00', `{"currencyCode":"USD","eventId":14967543,"priceRange":{"max":109.79,"min":35.65,"priceRangeMessage":null},"sections":[${section('General Admission ', 'M')},${section('VIP', 'H')}]}`));
  assert.equal(r.status, 'available');
  assert.equal(r.primary, null);
  assert.equal(r.fromPrimary, 35.65);
  assert.match(r.note, /2 of 2 ticket types on sale, availability M\/H/);
});

test('a Sold Out page: sold out, nothing left at the box office', () => {
  const r = readTicketWeb(page('Sold Out', '2026-03-25T10:00:00.000-07:00', '{"currencyCode":"USD","eventId":14788903,"priceRange":null,"sections":[]}'));
  assert.equal(r.status, 'soldout');
  assert.equal(r.primary, 0);
});

test('every ticket type sold out while the page still says On Sale counts as sold out', () => {
  const r = readTicketWeb(page('On Sale', '2026-03-25T10:00:00.000-07:00', `{"priceRange":null,"sections":[${section('GA', 'L', true)}]}`));
  assert.equal(r.status, 'soldout');
});

test('Off Sale before the on-sale time is presale; after it, none', () => {
  const now = Date.parse('2026-10-06T00:00:00Z');
  assert.equal(readTicketWeb(page('Off Sale', '2026-11-12T09:00:00.000-08:00', '{"priceRange":null,"sections":[]}'), now).status, 'presale');
  const r = readTicketWeb(page('Off Sale', '2026-08-12T09:00:00.000-07:00', '{"priceRange":null,"sections":[]}'), now);
  assert.equal(r.status, 'none');
  assert.match(r.note, /Off Sale/);
});

test('another status says nothing about tickets', () => {
  assert.equal(readTicketWeb(page('Cancelled', '2026-08-12T09:00:00.000-07:00', '{"priceRange":null,"sections":[]}')).status, 'unknown');
});

test('a page that is not a TicketWeb event page (the Opendate hand-off) is unknown', () => {
  const r = readTicketWeb('<html><script type="application/ld+json">{"@type":"Event","eventStatus":"https://schema.org/EventScheduled"}</script></html>');
  assert.equal(r.status, 'unknown');
  assert.match(r.note, /not a TicketWeb/);
});
