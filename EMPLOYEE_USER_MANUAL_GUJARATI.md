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

Diamond → `New Rough Purchase` ખોલો. Supplier, invoice/date અને purchase values भरो. દરેક actual rough piece માટે તેની ઓળખ, shape/weight જેવી દેખાતી વિગતો भरो અને Save કરો. એક physical piece ને duplicate row ન બનાવો. Save પછી `Rough Stock` માં lot/pieces અને status તપાસો.

## 7. Issue Rough, Custom Shape, partial/final receipt અને Recut

**Staff કરી શકે**

1. Diamond → Jobs માં `Issue Rough` ખોલો.
2. Karigar અને available rough piece પસંદ કરો.
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

---

આ manual fictional/general examples જ વાપરે છે. કોઈ વાસ્તવિક employee, customer, email, phone, password અથવા transaction data તેમાં ઉમેરશો નહીં.
