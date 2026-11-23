import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calmTitle, isNotice, dropAddOns } from './titles.mjs';

test('two or more shouted words come down to Title Case', () => {
  assert.equal(calmTitle('ANDREA BOCELLI'), 'Andrea Bocelli');
  assert.equal(calmTitle('THE B-52s * DANCE THIS MESS AROUND TOUR'), 'The B-52s * Dance This Mess Around Tour');
  assert.equal(calmTitle("ROCKIN' NEW YEAR'S EVE"), "Rockin' New Year's Eve");
});

test('a single shouted word is left as the act styles it', () => {
  assert.equal(calmTitle('WEEZER: The Voyage to the Blue Planet'), 'WEEZER: The Voyage to the Blue Planet');
  assert.equal(calmTitle('JOURNEY - Final Frontier Tour (An Evening With)'), 'JOURNEY - Final Frontier Tour (An Evening With)');
});

test('acronyms and styled names survive inside a shouted title', () => {
  assert.equal(calmTitle('MGMT LIVE IN CONCERT'), 'MGMT Live In Concert');
  assert.equal(calmTitle('DJ SHADOW AND CUT CHEMIST'), 'DJ Shadow And Cut Chemist');
  assert.equal(calmTitle('KATSEYE: BEAUTIFUL CHAOS TOUR'), 'KATSEYE: Beautiful Chaos Tour');
  assert.equal(calmTitle('UW HUSKIES VS. WSU COUGARS'), 'UW Huskies Vs. WSU Cougars');
});

test('mixed-case titles pass through untouched', () => {
  assert.equal(calmTitle('Seattle Storm vs. Las Vegas Aces'), 'Seattle Storm vs. Las Vegas Aces');
  assert.equal(calmTitle("USAA's Salute to Service"), "USAA's Salute to Service");
  assert.equal(calmTitle(''), '');
});

test('notices are recognised by title', () => {
  assert.equal(isNotice('Accelerate 2026: Playground Closure'), true);
  assert.equal(isNotice('Fisher Pavilion closed for a private event'), true);
  assert.equal(isNotice('Closer: The Musical'), false);
  assert.equal(isNotice('Monster Jam'), false);
});

test('a shouted Spanish title comes down whole: its articles and prepositions are words, not acronyms', () => {
  assert.equal(calmTitle('EL MUNDO DE FEDE VIGEVANI'), 'El Mundo De Fede Vigevani');
  assert.equal(calmTitle('YURIDIA - LAS CARTAS SOBRE LA MESA TOUR'), 'Yuridia - Las Cartas Sobre La Mesa Tour');
  assert.equal(calmTitle('PANTEÓN ROCOCÓ'), 'Panteón Rococó');
});

test('dropAddOns: a show\'s extras go when the venue has a real event that day, and stay when they are all there is', () => {
  const r = (venue, date, title) => ({ venue, date, title });
  const rows = [r('Arena', '2027-01-30', 'Harlem Globetrotters: Rivalry Tour'), r('Arena', '2027-01-30', 'Limited Edition Rivals Replica Game Ball From Spalding'), r('Arena', '2027-01-30', 'MVP Court Pass (Check In By 1:30PM)'), r('Arena', '2027-01-30', 'Ultimate Fan Pass: 30-min Exclusive On-Court Access'),
    r('Arena', '2027-02-19', 'PBR Two-Day Package - Ticket Includes Access to all days'), r('Arena', '2027-02-19', 'PBR Everett'), r('Hall', '2027-02-19', 'VIP Package: An Evening Alone'), r('Arena', '2027-03-01', 'Parking Lot Party')];
  assert.deepEqual(dropAddOns(rows).map((e) => e.title), ['Harlem Globetrotters: Rivalry Tour', 'PBR Everett', 'VIP Package: An Evening Alone', 'Parking Lot Party']);
});
