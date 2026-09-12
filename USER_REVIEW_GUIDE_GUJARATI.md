# ZYNORALUXE ERP — સરળ Review Guide

આ guide Owner માટે છે, જેથી software જાતે ચેક કરી શકાય. કોઈ password
અથવા secret આ file માં નથી.

---

## 1. Software કેવી રીતે ખોલવું

1. Computer પર browser ખોલો (Chrome, Edge, અથવા બીજું કોઈપણ).
2. Address barમાં લખો: `http://localhost:3000`
3. Login પેજ ખુલશે.

---

## 2. Login કેવી રીતે કરવું

- પહેલેથી save કરેલ Owner email અને password વાપરો (એ આ fileમાં
  લખેલ નથી — તમારી પાસે પહેલેથી છે).
- Email અને Password નાખો.
- "Log in" બટન દબાવો.
- Login થયા પછી Dashboard ખુલશે.

જો password ભૂલાઈ ગયો હોય, તો મને (developer/agent) જણાવો — હું
database directly touch કર્યા વગર નવો password set કરવાની process
સમજાવીશ.

---

## 3. ડાબી બાજુના 6 Menu Itemsનો અર્થ

| Menu | શું કામ કરે છે |
|---|---|
| **Dashboard** | આજની business સ્થિતિ — Cash, Bank, કેટલા રૂપિયા લેવાના/આપવાના, Rough/Polished stock, Karigar પાસે material, pending jobs — બધું એક નજરમાં. |
| **Accounting** | Purchase, Sale, Payment આપવું/લેવું, Expense — બધા પૈસાની entries. Parties (Customer/Supplier/Karigar) ની list, ledger, અને reports પણ અહીં. "New Sale" દબાવો ત્યારે હવે પહેલા પૂછશે — "Sell Finished Jewellery" (તૈયાર jewellery stock માંથી piece વેચવું, stock+profit આપોઆપ update થાય) કે "Other / Accounting-only Sale" (જૂની રીતે, ફક્ત accounting entry, stock touch ન થાય). |
| **Diamond** | Rough diamond ખરીદવું, Karigarને cutting-polishing માટે આપવું, Polished diamond પાછું લેવું, Polished stock જોવું. |
| **Jewellery Job** | Customer માટે jewellery job બનાવવો, Karigarને metal અને diamonds આપવા, તૈયાર jewellery પાછી લેવી. હવે 3 tabs: **Jobs**, **Metal Stock**, અને **Finished Stock** (તૈયાર jewellery ની list — કયો piece Available છે, કયો વેચાયો, ક્યાં return/damaged થયો). Finished Stock tab પર (ફક્ત Owner માટે) દરેક વેચેલા sale ને "Cancel sale" કરી શકાય, અને દરેક item ને "Return (Sellable)" કે "Return (Damaged)" કરી શકાય — તેમજ જેની Costing finalized હોય એવા item પર "Compare vs Costing" દબાવીને Phase 5 ના estimate profit અને Phase 6 ના real profit ની સરખામણી જોઈ શકાય. |
| **Costing** (ફક્ત Owner માટે) | કોઈ jewellery piece ની ખરી cost કાઢવી, વેચવા પહેલાં estimate બનાવવું, selling price અને profit નક્કી કરવું, Customer માટે સાફ quotation બનાવવું. |
| **Settings** (ફક્ત Owner માટે) | Company details, Staff accounts, Metal/Purity master, GST rates — બધા master settings. |

**નોંધ:** Staff account થી Login કરો તો "Costing" અને "Settings" menu
દેખાશે નહીં — એ ફક્ત Owner માટે છે, ઇરાદાપૂર્વક.

---

## 4. ટૂંકી Click-by-Click Review Checklist

આ steps ધીરે ધીરે, એક પછી એક કરો:

1. **Dashboard** ખોલો — બધા numbers અને "Live" label બરાબર દેખાય છે?
2. **Accounting → Transactions** — "New Purchase" બટન દબાવી form
   જુઓ (save ન કરો, ફક્ત જુઓ). પછી form બંધ કરો.
3. **Accounting → Parties** — એક નવો test Customer બનાવો (નામમાં
   "TEST" લખો, જેથી પછી ઓળખાય).
4. **Diamond → Rough Stock** — હાલનો rough stock જુઓ.
5. **Jewellery Job → Metal Stock** — હાલનું metal stock જુઓ.
6. **Costing → Cost Sheets** — હાલની costings ની list જુઓ. એક
   જૂની Finalized costing ખોલી "Open customer quotation" દબાવો —
   શું એમાં ફક્ત selling price દેખાય છે, cost/profit નહીં?
7. **Settings → Metal/Purity master** — 7 purity rows બરાબર
   દેખાય છે? (10K, 14K, 18K, 22K, 24K, 925 Silver, 950 Platinum)
8. **Jewellery Job → Finished Stock** — list જુઓ. Staff account થી
   જુઓ તો cost/profit column, "Compare vs Costing" બટન, અને sale
   cancel/return કરવાનું section — આ ત્રણેય ન દેખાવા જોઈએ, ફક્ત
   Owner account થી દેખાવા જોઈએ.
9. **Accounting → Transactions → New Sale** દબાવો — "Sell Finished
   Jewellery" પસંદ કરો (save ન કરો, ફક્ત form જુઓ), પછી "Other /
   Accounting-only Sale" પણ પસંદ કરી જુઓ — બંને બરાબર ખુલે છે?
10. **Jewellery Job → Finished Stock** પર નીચે "Finished Jewellery
    Sales — cancel / return" section જુઓ (ફક્ત Owner account થી) —
    કોઈ એક sale પર "Cancel sale" બટન દબાવો (save ન કરો, ફક્ત form
    ખુલે છે કે નહીં જુઓ, પછી "Back" દબાવીને બંધ કરો).
11. Mobile phone અથવા browserની window નાની કરીને પણ એકવાર જુઓ —
    બધું બરાબર દેખાય છે?

---

## 5. Testing વખતે શું ન કરવું

- **સાચા Customer, Supplier, Karigar, અથવા real business data ન
  વાપરો.** ટેસ્ટ માટે નામમાં હંમેશા "TEST" અથવા "TRIAL" લખો, જેથી
  પછી સહેલાઈથી શોધીને delete કરી શકાય.
- **Metal/Purity master ના 7 rows edit ન કરો** (ખાસ કરીને fineness
  %). જો edit કરવું જ પડે, તો પછી પાછું બરાબર કરવાનું ભૂલશો નહીં.
- **કોઈ real Purchase, Sale, Payment "Cancel" ન કરો** જ્યાં સુધી
  ખાતરી ન હોય કે એ ખોટી entry છે.
- **નવો Staff account બનાવો તો temporary/simple password જ વાપરો**,
  અને testing પછી remove કરી દો (Settings → Staff list માં
  "Deactivate" કરી શકાય). "Deactivate" દબાવતાની સાથે જ એ account
  ની access બંધ થઈ જાય છે — Staff already login થયેલ હોય તો પણ,
  next page ખોલતાં જ Login page પર પાછું મોકલી દેશે.
- **Company Settings માં state code `24` હાલ placeholder છે** —
  ખરો state code અને company details તમે પોતે update કરજો.

---

## 6. Problem report કેવી રીતે કરવું

જો કંઈ ખોટું દેખાય (error, ખોટો number, screen તૂટેલી), તો:

1. **Screenshot લો** — Windows પર `Windows + Shift + S` દબાવો,
   area select કરો, screenshot copy થઈ જશે.
2. Screenshot ને message/email માં paste કરો.
3. સાથે ટૂંકમાં લખો:
   - તમે કયા page પર હતા? (દા.ત. "Jewellery Job → Receive Finished")
   - તમે શું button/action દબાવ્યું?
   - શું થવું જોઈતું હતું, અને શું થયું?
4. જો કોઈ error message screen પર દેખાય, એ પણ screenshot માં
   આવવા દો — technical error text પણ ઉપયોગી છે.

---

## 7. નવું Security Feature — ખોટા Password પર થોડીવાર માટે Login બંધ

Software હવે ખોટા password વારંવાર નાખવાથી પોતાની જાતે થોડીવાર માટે
Login બંધ કરી દે છે — આ bug નથી, ઇરાદાપૂર્વક બનાવેલ security છે, જેથી
કોઈ બહારની વ્યક્તિ password guess કરવાની કોશિશ ન કરી શકે.

- **5 વાર ખોટો password** નાખવાથી એ email/account 15 મિનિટ માટે
  temporarily block થઈ જશે — સાચો password નાખો તો પણ એ 15 મિનિટ
  દરમિયાન Login નહીં થાય. Screen પર "Too many attempts. Please try
  again in about 15 minutes." એવો message દેખાશે.
- 15 મિનિટ પછી આપોઆપ ફરી Login કરી શકાશે — કંઈ કરવાની જરૂર નથી, ફક્ત
  રાહ જુઓ.
- **Owner ને પણ કાયમ માટે lock નહીં થાય** — વધુમાં વધુ 15 મિનિટ,
  પછી ફરી try કરી શકાય. જો ભૂલથી પોતાનો જ password 5 વાર ખોટો
  નાખાઈ જાય, તો ગભરાવાની જરૂર નથી — થોડીવાર રાહ જોઈને ફરી try કરો.
- આ security ફક્ત password ખોટો હોય ત્યારે જ લાગુ પડે છે — સાચા
  password થી પહેલા જ પ્રયત્નમાં Login કરવામાં કોઈ ફરક નહીં પડે.
- Software એ કોઈનો પણ real email, IP address, કે password ક્યાંય
  save કરતું નથી — ફક્ત "કેટલી વાર ખોટો પ્રયત્ન થયો" એ count રાખે
  છે, જે થોડા સમય પછી આપોઆપ delete થઈ જાય છે.

ઉપરાંત, software હવે વધારાના security headers (browserને કહેતા rules
કે કઈ website/script પર ભરોસો કરવો) સાથે ચાલે છે — આ Owner માટે
screen પર કંઈ અલગ દેખાય એવું નથી, ફક્ત background માં વધારાનું
રક્ષણ છે. જો કોઈ page/button કંઈક "blocked" અથવા "not loading" જેવું
અસામાન્ય વર્તન બતાવે, તો §6 પ્રમાણે screenshot સાથે report કરો.

---

આટલું follow કરવાથી software ને real business use પહેલાં સારી રીતે
ચકાસી શકાશે. કોઈપણ પ્રશ્ન હોય તો develop કરનારને પૂછવામાં સંકોચ ન
રાખશો.
