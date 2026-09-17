# ZYNORALUXE ERP — Employee User Manual

આ માર્ગદર્શિકા Gujarati-first છે. Software માં દેખાતા English button અને field labels અહીં એ જ રીતે લખ્યા છે.

> **સાવધાની — Save કરતાં પહેલાં ચેક કરો:** Party, તારીખ, રકમ/વજન, GST type અને નોંધ ફરી વાંચો. Save એક જ વાર દબાવો અને જવાબની રાહ જુઓ.

## 1. Login, Logout અને Dashboard

**Staff કરી શકે**

1. Login page પર `Email` અને `Password` ભરો.
2. `Log in` દબાવો. Password કોઈ સાથે share ન કરો.
3. Dashboard ના cards અને quick actions થી જરૂરી module ખોલો.
4. કામ પૂરું થાય ત્યારે sidebar ના નીચેના `Logout` થી session બંધ કરો—ખાસ કરીને shared computer પર.

Login ન થાય તો spelling, Caps Lock અને internet તપાસો. વારંવાર password અજમાવી account lock ન કરો; Owner ને જણાવો.

## 2. Parties — Customer, Supplier અને Karigar

**Staff કરી શકે**

- Customer: જેને માલ વેચીએ.
- Supplier: જેની પાસેથી માલ ખરીદીએ.
- Karigar: જેને diamond/jewellery નું કામ આપીએ.

Accounting → `Parties` માં `Party type`, `Name`, phone/GST વિગતો ભરી `Add party` દબાવો. Duplicate નામ બનાવતાં પહેલાં list/search તપાસો. Edit ઉપલબ્ધ હોય તો માત્ર સાચી master detail સુધારો; વ્યવહાર સુધારવા Party edit ન વાપરો.

## 3. Opening Receivable/Payable અને ભૂલ સુધારવી

નવી Party બનાવતી વખતે opening balance હોય ત્યારે જ opening receivable/payable भरो. Customer પાસેથી લેવાના હોય તો receivable; Supplier ને આપવાના હોય તો payable. Direction ઉલટી ન કરવી.

**સાવધાની:** posted transaction delete/edit ન કરો. Accounting → `Transactions` માં entry ખોલો, Owner ને જાણ કરો અને ઉપલબ્ધ `Cancel entry` → reason → `Confirm cancel` workflow વાપરો. System reversal બનાવે છે; ત્યારબાદ સાચી entry નવી બનાવો. Finished Jewellery Sale સાથે જોડાયેલી entry તેની sale workflow માંથી જ સુધારવી.

## 4. Purchase, Sale, Payment Given, Payment Received અને Expense

Accounting → `Transactions` માં યોગ્ય action પસંદ કરો:

- `Purchase`: Supplier પાસેથી ખરીદી. Supplier, invoice, taxable value અને GST તપાસો.
- `Sale`: Customer ને સામાન્ય invoice sale. Customer અને tax તપાસો.
- `Payment Given`: Supplier/બીજી Party ને ચૂકવેલ રકમ અને payment account પસંદ કરો.
- `Payment Received`: Customer પાસેથી મળેલી રકમ અને payment account પસંદ કરો.
- `Expense`: business ખર્ચ અને યોગ્ય expense/payment account પસંદ કરો.

Preview/totals ચકાસ્યા પછી જ form નો Save/Create button દબાવો. એક જ વ્યવહાર બે વાર દાખલ ન કરો.

## 5. CGST + SGST કે IGST

- Company અને Party એક જ રાજ્યમાં હોય તો `CGST + SGST`.
- અલગ રાજ્યમાં હોય તો `IGST`.
- ખાતરી ન હોય તો invoice/GSTIN જોઈ Owner પાસે પૂછો.

**Save કરતાં પહેલાં ચેક કરો:** GST treatment, rate, taxable value અને total. ખોટું GST post થયા પછી જૂની entry બદલવાને બદલે cancel/reversal કરીને સાચી entry બનાવો.

## 6. Rough Purchase અને rough pieces

Diamond → `New Rough Purchase` ખોલો. Supplier, invoice/date અને purchase values भरो. દરેક actual rough piece માટે તેની ઓળખ, shape/weight જેવી દેખાતી વિગતો भरो અને Save કરો. એક physical piece ને duplicate row ન બનાવો. Save પછી `Rough Diamond` માં lot/pieces અને status તપાસો.

## 7. Issue Rough, Custom Shape, partial/final receipt અને Recut

**Staff કરી શકે**

1. Diamond → `Manufacturer` માં `Issue Rough` ખોલો.
2. `Karigar / Manufacturer` અને available rough piece પસંદ કરો (process માટે §18 જુઓ).
3. Shape list માં ન હોય તો `Custom` પસંદ કરીને સાચું shape લખો.
4. `Issue Rough` પહેલાં piece, Karigar અને weight તપાસો.
5. માલ પાછો આવે ત્યારે job ખોલી `Receive Polished` વાપરો.
6. દરેક output માં polished weight અને disposition સાચું પસંદ કરો: `SET` એટલે stock માટે polished diamond; `RETURNED` એટલે unprocessed rough પાછું આવ્યું.
7. થોડું જ પાછું આવ્યું હોય તો partial receipt; બધું હિસાબ પૂર્ણ થાય ત્યારે final receipt કરો.
8. Available polished diamond ફરી કાપવો હોય તો `Mark for recut`, reason અને `Confirm` વાપરો.

Receipt થયા પછી job cancel કરવાનો પ્રયત્ન ન કરો; ભૂલ હોય તો Owner ને જણાવો.

## 8. Metal/Purity અને Metal Stock

Jewellery Jobs → `Metal Stock` → purchase/add workflow માં Supplier, metal/purity, gross weight, amount અને invoice details भरो. `Gold 22K` અને `Gold 18K` જેવી purity અલગ stock છે; label જોઈ પસંદ કરો. Save પછી stock quantity તપાસો.

**ફક્ત Owner:** Settings માં Metal/Purity master બદલી શકે. જૂની purity ની fineness બદલતાં પહેલાં historical stock પર અસર સમજવી જરૂરી છે.

## 9. Jewellery Job — create, issue, receive અને correction

**Staff કરી શકે**

1. Jewellery Jobs → `New Jewellery Job` માં Karigar, description અને job details भरो; `Create Jewellery Job` દબાવો.
2. Job ખોલી `Issue Materials` થી available metal અને diamonds જ આપો.
3. Actual quantity/weight આપ્યા પછી Save કરો અને balances તપાસો.
4. તૈયાર માલ થોડો આવે તો `Receive Finished Jewellery` માં partial receipt કરો.
5. છેલ્લી receipt વખતે remaining metal/diamonds અને returned/scrap values પૂરા મેળવો; પછી final receipt કરો.

Material issue પછી સીધું original record બદલશો નહીં. ઉપલબ્ધ correction/override action Owner ની મંજૂરીથી જ વાપરો. Received output હોય તો job cancel ન થઈ શકે; Owner ને જણાવો.

## 10. Diamond `SET` અને `RETURNED`

- `SET`: diamond finished jewellery માં લગાડ્યો છે; piece સાથે તેનો હિસાબ જશે.
- `RETURNED`: unused diamond Karigar પાસેથી પાછો આવ્યો છે અને polished stock માં પાછો ઉપલબ્ધ થશે.

એક diamond માટે બંને પસંદ ન કરો. Physical માલ સાથે line-by-line મેળવો.

## 11. Finished Jewellery Stock અને Sales

Jewellery Jobs → `Finished Stock` માં `Available` piece જ વેચી શકાય. Accounting ના finished-jewellery sale workflow માં Customer, date/invoice, available pieces, selling amounts, discount અને GST भरो. Preview તપાસીને sale Save કરો. Save પછી piece `Sold` અને accounting transaction બંને દેખાવા જોઈએ.

## 12. Sellable Return, Damaged Return, Refund અને Sale Cancellation

Sale detail માં સાચી line પસંદ કરીને return action વાપરો:

- `Sellable Return`: piece સારી હાલતમાં પાછું આવ્યું; stock ફરી `Available` થાય.
- `Damaged Return`: piece ફરી વેચવા લાયક નથી; damaged status થાય.
- `Refund`: Customer ને ખરેખર પૈસા પાછા આપ્યા ત્યારે payment account અને amount સાથે refund record કરો.
- `Cancel sale`: આખું ખોટું વેચાણ undo કરવા reason ભરી `Confirm cancellation` કરો; stock/accounting/GST reverse થાય.

**સાવધાની:** return અને refund એક જ વસ્તુ નથી. Piece પાછું આવવું અને પૈસા પાછા આપવું અલગ પગલાં હોઈ શકે. કોઈ line પહેલેથી returned હોય તો આખી sale cancel ન કરો; Owner ને જણાવો.

## 13. રોજનું Opening/Closing Checklist

### Opening

- પોતાના Staff account થી login કરો.
- Dashboard પર pending/active jobs જુઓ.
- હાથમાં રહેલા cash, rough, polished, metal અને finished pieces ને system ના સંબંધિત stock સાથે મેળવો.
- ગઈકાલની unresolved ભૂલ Owner સાથે clear કરો.

### Closing

- આજની purchase/sale/payment/expense entries list માં દેખાય છે તે તપાસો.
- Karigar ને આપેલ અને પાછું આવેલ material/job-wise મેળવો.
- Finished sales/returns અને physical pieces મેળવો.
- Pending mismatch લખીને Owner ને જણાવો; અંદાજથી adjustment ન કરો.
- `Logout` કરો.

## 14. સામાન્ય તકલીફો અને safe response

- `Save` કામ કરતું લાગે નહીં: એક વાર દબાવી રાહ જુઓ; repeated clicks ન કરો.
- Validation message: highlighted field વાંચી સાચી value भरो; message bypass ન કરો.
- Item/Party દેખાતી નથી: spelling/filter/status તપાસો; duplicate બનાવશો નહીં.
- Stock ઓછો બતાવે: physical stock ફરી ગણો અને Owner ને જણાવો; fake purchase/receipt ન બનાવો.
- ખોટી entry: નવી opposite entry પોતાની રીતે ન બનાવો; approved cancel/reversal workflow વાપરો.
- Internet/database error: form details નોંધો, connection આવ્યા પછી list ચકાસી ફરી પ્રયત્ન કરો.
- Unauthorized page: access મેળવવા Owner credentials ન માગો; Owner ને કામ સોંપો.

## 15. Costing — ફક્ત Owner

**ફક્ત Owner — internal cost, COGS, profit, margin અને inventory value Staff સાથે share ન કરો.**

Costing → `New Costing` માં `A piece we already finished` (actual) અથવા `An estimate before making it` પસંદ કરો. Source/material/labour/charges તપાસો. Selling price માટે `Markup on cost` અથવા `Target margin on selling price` સમજીને વાપરો. Draft તપાસ્યા પછી `Finalize`; બદલાવ જોઈએ તો `Revise`; જૂની finalized history rewrite ન કરો. `Archive` delete નથી; જરૂર પડે `Restore from archive`. Finalized sheet પરથી `Open customer quotation` customer-safe output આપે છે. `Compare vs Costing` થી estimate અને realized result સરખાવો.

## 16. Settings અને Staff accounts — ફક્ત Owner

Settings → `Company details` માં company/GST details માત્ર verified document પ્રમાણે બદલવી. `Staff accounts` → `Add a Staff account` માં Name, Email અને Temporary password ભરી `Add staff account` દબાવો. દરેક employee માટે અલગ account રાખો; Owner password share ન કરો. Employee જાય ત્યારે `Deactivate`; પાછો આવે ત્યારે જ `Reactivate`.

Metal/Purity master અને Accounting settings ના GST/payment accounts બદલતાં પહેલાં existing transactions પર અસર તપાસો. Credentials, database URL, keys, session values અથવા private configuration manual/notes માં ક્યારેય ન લખો.

**ફક્ત Owner:** Settings → `Manufacturer processes` માં process ઉમેરો, નામ બદલો કે Inactive કરો. બદલાવ ફક્ત પછી issue થતા jobs પર લાગે છે.

## 17. Polished Diamond ખરીદી — Party / Supplier અને Dalal / Broker

**Staff કરી શકે**

1. Diamond → `Polished Diamond` → `+ New Polished Purchase` ખોલો.
2. Purchase date અને `Party / Supplier` પસંદ કરો.
3. દરેક size માટે એક packet line: Shape, Size, Pieces, Carat, Quality, Colour, certificate અને rate ભરો. એક physical packet ને બે lines માં ન તોડો.
4. Supplier bill નું amount (GST અને brokerage વગર) ભરો. Packet rates નો સરવાળો અલગ આવે તો warning દેખાશે — bill સાથે મેળવો.
5. Dalal હોય તો `Dalal / Broker` ભાગમાં brokerage પસંદ કરો: bill માં પહેલેથી સામેલ, diamond ની કિંમતમાં ઉમેરવું, કે business expense. પછી Dalal, method (percentage / per carat / fixed) અને rate ભરો.
6. નીચે Payable to Party / Supplier, Payable to Dalal / Broker અને Landed diamond cost તપાસી `Save polished purchase` દબાવો.

Brokerage એક જ વાર નોંધાય છે. Dalal ને payment પછીથી Accounting → `Payment Given` થી આપો. `Grouped stock` માં એકસરખા stones સાથે દેખાય છે; ખરીદેલા અને rough માંથી બનેલા stones ક્યારેય ભેગા થતા નથી.

**ફક્ત Owner:** `Cancel purchase` (કોઈ packet વપરાયો ન હોય ત્યાં સુધી જ) અને ગણતરીમાં ફરક આવે ત્યારે `Adjust count`. ભૂલ થાય તો ઊલટું adjustment કરો, record delete નહીં.

## 18. Manufacturer — process માટે rough આપવો

1. Diamond → `Manufacturer` → `Issue Rough` ખોલો.
2. `Karigar / Manufacturer` અને rough pieces પસંદ કરો.
3. `Process` પસંદ કરો: `4P / Laser`, `HPHT / Grow`, `Polishing` અથવા `Rough Polish`. Process ન હોય તો સામાન્ય cutting & polishing.
4. Charge નક્કી હોય તો `Process charge` (Per carat / Per piece / Fixed amount) અને rate ભરો. Fixed charge job પૂરો થાય ત્યારે જ લાગે છે.
5. `4P / Laser`, `HPHT / Grow`, `Rough Polish` માંથી માલ rough તરીકે આવે: job ખોલી `Receive processed rough` માં દરેક piece નો carat ભરો — દરેક piece નવો Rough Diamond piece બનશે.
6. `Polishing` માંથી polished આવે: `Receive Polished` વાપરો.

`HPHT / Grow` ફક્ત બહાર કરાવેલું issue-return કામ છે. થોડું જ પાછું આવ્યું હોય તો બાકીનું Manufacturer પાસે pending રહે; "Nothing more will come back" ટીક કરો ત્યારે જ weight loss ગણાય.

## 19. Job Manufacturer — polished packets process માટે

1. Diamond → `Job Manufacturer` → `Issue packets` ખોલો.
2. Manufacturer, Process, Issue date અને charge ભરો.
3. દરેક packet માંથી આપેલા Pieces અને Carat ભરો (size-wise). બધા pieces લો તો બધો carat પણ લેવો પડે.
4. `Issue to Manufacturer` દબાવો.
5. માલ પાછો આવે: job ખોલી `Receive return`. દરેક size માટે પસંદ કરો — `Returned to stock`, `Used in Jewellery Job` (કયો job એ પસંદ કરો), અથવા `Damaged/Lost (Owner)` કારણ સાથે.
6. Size બદલાઈ હોય તો "Size (if changed)" માં નવી size લખો — નવો packet બનશે.
7. `Save return` દબાવો.

એક packet ના બધા pieces પાછા ન આવે ત્યાં સુધી બાકીનો માલ pending રહે છે, loss નહીં. દરેક packet line નીચે હિસાબ દેખાય છે: Issued, Pending before, This return, Still with Manufacturer.

બધા pieces પાછા આવી ગયા હોય પણ carat ઓછો હોય, તો line આપોઆપ બંધ થતી નથી. હિસાબ તપાસી "Close this line — record … ct as Process Loss" જાતે ટીક કરો; બાકીના packets ખુલ્લા રહી શકે છે. એ જ return માં ટીક કરવું સારું — પછીથી ટીક કરો તો loss expense તરીકે જાય છે. Pieces અને carat બંને પૂરા મળે તો line loss વગર જાતે બંધ થાય છે.

બંધ થયેલી line માં પછી કોઈ return નોંધી શકાતું નથી — ભૂલ લાગે તો Owner ને જણાવો. આખો job બંધ કરવા "Nothing more will come back" ટીક કરો — ત્યારે દરેક piece નો હિસાબ આપવો જ પડે.

**ફક્ત Owner:** Damaged/Lost, abnormal loss, અને કોઈ return આવ્યા પહેલાં `Cancel job`.

## 20. 24K Issued → 18K / 14K / 9K અને Alloy Added

1. Jewellery Job ખોલી `Issue Materials` માં 24K gold આપો. Company નું Copper/Alloy આપવું હોય તો `Copper/Alloy` purity ની line ઉમેરો.
2. Polished packets વાપરવા હોય તો "Polished Diamond packets" માં દરેક packet ના Pieces અને Carat ભરો.
3. માલ આવે ત્યારે `Receive Finished Jewellery` ખોલો — ઉપર "24K Issued" દેખાશે.
4. દરેક output માં net weight અને `Final Purity: 18K / 14K / 9K` પસંદ કરો. `Fine Gold Weight` અને `Alloy Added` આપોઆપ ગણાશે.
5. `Alloy Added` ને વહેંચો: `From Company Copper/Alloy (g)`, `Karigar-added alloy (g)` (charge હોય તો `Karigar alloy charge (₹)`), અથવા `Included, no separate cost (g)`. સરવાળો બરાબર Alloy Added જેટલો જ હોવો જોઈએ.
6. `Returned Gold` અને `Scrap` ભરો; packet stones માટે Set / Returned / Damaged (Owner) ભરો.
7. નીચે Reconciliation તપાસો — હિસાબ મળે નહીં ત્યાં સુધી Save નહીં થાય.

ઉદાહરણ: 10.000 g 24K (100%) આપ્યું → 12.000 g 18K આવ્યું = 9.000 g fine gold + 3.000 g alloy, અને 1.000 g fine `Process Loss`. Scrap અલગ stock માં જાય છે અને ફરી issue થતો નથી. 9K = 37.5%, 14K = 58.5%, 18K = 75%.

---

આ manual fictional/general examples જ વાપરે છે. કોઈ વાસ્તવિક employee, customer, email, phone, password અથવા transaction data તેમાં ઉમેરશો નહીં.
