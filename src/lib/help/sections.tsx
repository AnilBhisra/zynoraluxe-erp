import type { ReactNode } from "react";
import { StaffCanBadge, OwnerOnlyBadge, CautionBadge, CheckBeforeSaveBadge } from "@/components/help/HelpBadges";

export type HelpSection = {
  id: string;
  title: string;
  ownerOnly?: boolean;
  keywords: string[];
  body: ReactNode;
};

export type HelpTaskCard = {
  id: string;
  label: string;
  anchor: string;
};

/** Every task card is reachable by both roles — none of the 15 required
 * cards point at an Owner-only section. */
export const TASK_CARDS: HelpTaskCard[] = [
  { id: "new-party", label: "નવી Party બનાવવી", anchor: "task-new-party" },
  { id: "new-purchase", label: "માલ ખરીદ્યો", anchor: "task-new-purchase" },
  { id: "payment-given", label: "Supplierને પૈસા આપ્યા", anchor: "task-payment-given" },
  { id: "payment-received", label: "Customer પાસેથી પૈસા આવ્યા", anchor: "task-payment-received" },
  { id: "rough-purchase", label: "Rough Diamond ખરીદવો", anchor: "task-rough-purchase" },
  { id: "issue-rough", label: "Rough Karigarને આપવો", anchor: "task-issue-rough" },
  { id: "receive-polished", label: "Polished Diamond પાછો લેવો", anchor: "task-receive-polished" },
  { id: "metal-stock", label: "Metal Stock ઉમેરવો", anchor: "task-metal-stock" },
  { id: "new-jewellery-job", label: "Jewellery Job બનાવવો", anchor: "task-new-jewellery-job" },
  { id: "receive-finished", label: "Finished Jewellery પાછી લેવી", anchor: "task-receive-finished" },
  { id: "finished-sale", label: "Finished Jewellery વેચવી", anchor: "task-finished-sale" },
  { id: "sale-return", label: "Sale Return કરવી", anchor: "task-sale-return" },
  { id: "refund", label: "Refund આપવો", anchor: "task-refund" },
  { id: "fix-mistake", label: "ભૂલ સુધારવી", anchor: "task-fix-mistake" },
  { id: "login-help", label: "Password/Loginની મદદ", anchor: "task-login-help" },
];

function Btn({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-[13px] font-medium text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100">
      {children}
    </span>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</ol>;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400">
      {children}
    </p>
  );
}

function SubHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mt-6 scroll-mt-24 text-sm font-semibold text-zinc-900 first:mt-0 dark:text-zinc-50">
      {children}
    </h3>
  );
}

function BadgeRow({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex flex-wrap gap-1.5">{children}</div>;
}

export function getHelpSections(role: "OWNER" | "STAFF"): HelpSection[] {
  const isOwner = role === "OWNER";

  const sections: HelpSection[] = [
    // ------------------------------------------------------------------
    {
      id: "login",
      title: "Login અને Dashboard",
      keywords: ["login", "logout", "password", "dashboard", "લોગિન", "ડેશબોર્ડ", "પાસવર્ડ"],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading>Login કેવી રીતે કરવું</SubHeading>
          <Steps>
            <li>Browser ખોલો અને સોફ્ટવેરનું સરનામું (address) ખોલો.</li>
            <li>
              <Btn>Email</Btn> અને <Btn>Password</Btn> બોક્સમાં તમારો email અને password લખો.
            </li>
            <li>
              <Btn>Log in</Btn> દબાવો.
            </li>
            <li>Login સાચું હોય તો Dashboard પેજ ખુલશે.</li>
          </Steps>

          <SubHeading id="task-login-help">Logout કેવી રીતે કરવું, અને Password/Login મદદ</SubHeading>
          <Steps>
            <li>ડાબી બાજુ (mobile પર ઉપર menu માં) તમારું નામ નીચે <Btn>Log out</Btn> બટન દબાવો.</li>
            <li>Computer બીજું કોઈ વાપરે તે પહેલાં હંમેશા Logout કરો — ખાસ કરીને shared/shop ના computer પર.</li>
          </Steps>
          <Note>
            પાસવર્ડ ભૂલી ગયા હો, અથવા વારંવાર ખોટો પાસવર્ડ નાખવાથી થોડીવાર માટે Login બંધ થઈ ગયું હોય (“Too many attempts” જેવો message), તો ગભરાવાની જરૂર નથી — થોડીવાર રાહ જુઓ અથવા Owner ને જણાવો. Password ફક્ત Owner બદલી શકે છે (Settings → Staff accounts).
          </Note>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            ક્યારેય તમારો password બીજા કોઈને ના આપો — Owner ને પણ નહીં માંગવો પડે, Owner પોતે Settings માંથી નવો password set કરી શકે છે.
          </p>

          <SubHeading>Dashboard ના cards નો અર્થ</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li><strong>Cash balance / Bank balance</strong> — રોકડ અને bank માં કેટલા પૈસા છે (accounting entries પ્રમાણે).</li>
            <li><strong>Receivable</strong> — Customer પાસેથી કેટલા પૈસા લેવાના બાકી છે.</li>
            <li><strong>Payable</strong> — Supplier/Karigar ને કેટલા પૈસા આપવાના બાકી છે.</li>
            <li><strong>Rough stock</strong> — હાલમાં કેટલા carat rough diamond ઉપલબ્ધ (available) છે.</li>
            <li><strong>Polished stock</strong> — હાલમાં કેટલા carat polished diamond ઉપલબ્ધ છે.</li>
            <li><strong>Material with Karigar</strong> — Karigar પાસે કામ ચાલુ હોય એટલું material.</li>
            <li><strong>Pending jewellery jobs</strong> — હજુ પૂરી ન થયેલી jewellery jobs ની સંખ્યા.</li>
            <li><strong>Finished stock (Available)</strong> — વેચવા માટે તૈયાર jewellery ના પીસની સંખ્યા.</li>
          </ul>

          <SubHeading>₹0.00 અથવા 0.000 ct નો અર્થ શું</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <strong>₹0.00</strong> એટલે ખરેખર zero — કંઈ error નથી. જેમ કે નવો, ખાલી account હોય, અથવા બધું બરાબર settle થઈ ગયું હોય (કોઈ પૈસા લેવાના/આપવાના બાકી ન હોય) ત્યારે આ સાચું, સામાન્ય પરિણામ છે. એ જ રીતે <strong>0.000 ct</strong> એટલે હાલમાં કોઈ rough/polished stock ઉપલબ્ધ નથી. જો તમને લાગે કે આ number ખોટો છે (દા.ત. તમે હમણાં જ માલ ઉમેર્યો હોવા છતાં 0 દેખાય છે), પહેલાં પેજ Refresh કરો (નીચે જુઓ); તોય ખોટું લાગે તો Owner ને જણાવો.
          </p>

          <SubHeading>પેજ સુરક્ષિત રીતે Refresh કેવી રીતે કરવું</SubHeading>
          <Steps>
            <li>Browser ના Refresh બટન (ગોળ તીર) દબાવો, અથવા keyboard પર F5 દબાવો.</li>
            <li>જો કોઈ form ખુલ્લું હોય અને તમે અધૂરી માહિતી ભરી હોય, Refresh કરવાથી એ ભરેલી માહિતી ભૂંસાઈ જશે — Save કરેલા પછી જ Refresh કરો.</li>
            <li>Save દબાવ્યા પછી, page આપોઆપ update થાય છે — સામાન્ય રીતે manually Refresh કરવાની જરૂર નથી.</li>
          </Steps>

          <SubHeading>Access બંધ થઈ ગયું હોય તો શું કરવું</SubHeading>
          <Steps>
            <li>
              “This page isn&apos;t available to your account” જેવો message દેખાય, તો એ page ફક્ત Owner માટે છે — Staff માટે નહીં. આ error નથી, ઇરાદાપૂર્વક છે.
            </li>
            <li>
              <Btn>Back to Dashboard</Btn> દબાવીને પાછા જાવ.
            </li>
            <li>Login જ ના થાય (સાચો password નાખવા છતાં), તો Owner ને જણાવો — તમારું account inactive/deactivate થયેલું હોઈ શકે.</li>
          </Steps>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "parties",
      title: "Parties (Customer, Supplier, Karigar)",
      keywords: ["party", "customer", "supplier", "karigar", "પાર્ટી", "કસ્ટમર", "સપ્લાયર", "કારીગર", "opening balance", "archive"],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading>ત્રણ પ્રકારના Party</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li><strong>Customer</strong> = જેને આપણે વેચીએ.</li>
            <li><strong>Supplier</strong> = જેની પાસેથી ખરીદીએ.</li>
            <li><strong>Karigar</strong> = જેને manufacturing work આપીએ (rough diamond કે metal cutting/making માટે).</li>
          </ul>

          <SubHeading id="task-new-party">નવી Party કેવી રીતે બનાવવી</SubHeading>
          <Steps>
            <li>Accounting → Parties પર જાવ.</li>
            <li><Btn>Name</Btn> માં નામ લખો.</li>
            <li><Btn>Party type</Btn> માંથી Customer, Supplier કે Karigar પસંદ કરો.</li>
            <li>Phone/Email ઇચ્છા મુજબ ભરો.</li>
            <li>જો આ Party પાસેથી પહેલેથી પૈસા લેવાના/આપવાના હોય, “This party already owes money, or is already owed money” ચેકબોક્સ ચેક કરો, રકમ અને Direction (તેઓ આપણને આપશે / આપણે તેમને આપીશું) પસંદ કરો.</li>
            <li><Btn>Add party</Btn> દબાવો.</li>
            <li>“Party added.” message દેખાય એટલે party સચવાઈ ગઈ.</li>
          </Steps>

          <SubHeading>Opening Receivable vs Opening Payable</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <strong>Receivable</strong> = “They owe us” — તેઓ આપણને પૈસા આપશે (દા.ત. નવો Customer જેની પાસે જૂનું ઉધાર છે). <strong>Payable</strong> = “We owe them” — આપણે તેમને પૈસા આપીશું (દા.ત. નવો Supplier જેની પાસેથી પહેલેથી માલ લીધો છે પણ પૈસા બાકી છે).
          </p>
          <BadgeRow>
            <CheckBeforeSaveBadge />
          </BadgeRow>
          <Note>Opening balance ફક્ત Party બનાવતી વખતે જ ભરાય છે — પછીથી edit form માં opening balance બદલવાનો કોઈ વિકલ્પ નથી. તેથી Save કરતાં પહેલાં રકમ અને Direction બંને ચેક કરો.</Note>

          <SubHeading>Party કેવી રીતે Edit કરવી</SubHeading>
          <Steps>
            <li>Parties ની yaadi માં એ party ની બાજુમાં <Btn>Edit</Btn> દબાવો.</li>
            <li>જરૂરી ફેરફાર કરો.</li>
            <li><Btn>Save changes</Btn> દબાવો.</li>
          </Steps>

          <SubHeading>Staff શું Edit કરી શકે, શું ફક્ત Owner કરી શકે</SubHeading>
          <BadgeRow>
            <StaffCanBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">Staff ફક્ત Phone, Email અને Address બદલી શકે.</p>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Name, Party type, GSTIN અને State details ફક્ત Owner બદલી શકે. Staff એ બદલવાની કોશિશ કરે તો સોફ્ટવેર પોતે ના પાડી દેશે.
          </p>

          <SubHeading>Party Archive (કાયમ માટે Delete નહીં)</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            કોઈ Party હવે વાપરવાની ના હોય, તો એને <strong>Delete</strong> નહીં — <strong>Archive</strong> કરવાની હોય છે. Archive કરેલી party ની જૂની history (જૂના purchase/sale/payment) સચવાયેલી રહે છે, ફક્ત નવા વ્યવહાર માટે એ list માં નહીં દેખાય.
          </p>
          <Steps>
            <li>Parties ની yaadi માં Party ની બાજુમાં <Btn>Archive</Btn> દબાવો (ફક્ત Owner).</li>
            <li>પાછી જરૂર પડે તો એ જ જગ્યાએ <Btn>Reactivate</Btn> દબાવો.</li>
          </Steps>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>

          <SubHeading>Opening Balance ખોટો ભરાઈ ગયો હોય તો શું કરવું</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Opening balance ને directly edit કરવાનો કોઈ રસ્તો સોફ્ટવેરમાં નથી — ઇરાદાપૂર્વક, જેથી હિસાબમાં કોઈ number ચૂપચાપ ના બદલાય. સાચી રીત:
          </p>
          <Steps>
            <li>Accounting → Transactions માં જાવ, જ્યાં એ party ની “Opening Balance” entry દેખાય છે.</li>
            <li>એ entry ની બાજુમાં <Btn>Cancel</Btn> દબાવો (આ ફક્ત Owner કરી શકે).</li>
            <li>“Cancellation reason” માં ટૂંકમાં કારણ લખો (દા.ત. “ખોટી રકમ ભરાઈ ગઈ, સાચી રકમ ₹10,000 છે”).</li>
            <li><Btn>Confirm cancel</Btn> દબાવો — આ જૂની ખોટી entry ને reverse (ઊલટી) કરી નાખશે.</li>
            <li>જરૂર પડે તો સાચી નવી Party/entry ફરીથી બનાવો.</li>
          </Steps>
          <BadgeRow>
            <OwnerOnlyBadge />
            <CautionBadge />
          </BadgeRow>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "accounting",
      title: "Accounting — Purchase, Sale, Payment, Expense",
      keywords: [
        "purchase", "sale", "payment", "expense", "gst", "cgst", "sgst", "igst",
        "ખરીદી", "વેચાણ", "પેમેન્ટ", "ખર્ચ", "જીએસટી",
      ],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading id="task-new-purchase">New Purchase (માલ ખરીદ્યો)</SubHeading>
          <Steps>
            <li>Accounting → Transactions પર જાવ.</li>
            <li><Btn>New Purchase</Btn> દબાવો.</li>
            <li>સાચો Supplier, તારીખ, વસ્તુની વિગત, રકમ અને GST પસંદ કરો.</li>
            <li>ફોર્મ ભરાઈ ગયા પછી Save બટન દબાવો.</li>
            <li>“Purchase saved as ...” message દેખાય એટલે entry સચવાઈ ગઈ.</li>
          </Steps>

          <SubHeading id="task-payment-given">Supplierને પૈસા આપ્યા (Payment Given)</SubHeading>
          <Steps>
            <li><Btn>Payment Given</Btn> દબાવો.</li>
            <li>સાચો Supplier/Karigar, રકમ, અને કયા account (Cash/Bank) માંથી પૈસા આપ્યા એ પસંદ કરો.</li>
            <li>Save દબાવો — “Payment Given saved as ...” message આવે.</li>
          </Steps>

          <SubHeading id="task-payment-received">Customer પાસેથી પૈસા આવ્યા (Payment Received)</SubHeading>
          <Steps>
            <li><Btn>Payment Received</Btn> દબાવો.</li>
            <li>સાચો Customer, રકમ, અને કયા account માં પૈસા જમા થયા એ પસંદ કરો.</li>
            <li>Save દબાવો — “Payment Received saved as ...” message આવે.</li>
          </Steps>

          <SubHeading>New Expense</SubHeading>
          <Steps>
            <li><Btn>New Expense</Btn> દબાવો.</li>
            <li>ખર્ચની વિગત, રકમ, તારીખ ભરો.</li>
            <li>Save દબાવો.</li>
          </Steps>

          <SubHeading>New Sale — બે પ્રકાર</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <Btn>New Sale</Btn> દબાવો ત્યારે પહેલાં પૂછશે — “What are you selling?”:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li>
              <strong>Sell Finished Jewellery</strong> — તૈયાર (Finished) stock માંથી ખરેખર એક piece વેચવો. આ Stock ઓછો કરે છે અને સંબંધિત Accounting entry આપોઆપ બનાવે છે. રોજિંદા jewellery ના વેચાણ માટે આ જ વાપરવાનું છે — વિગત “Finished Stock and Sales” section માં છે.
            </li>
            <li>
              <strong>Other / Accounting-only Sale</strong> — ફક્ત હિસાબની entry, કોઈ Finished Jewellery stock touch નથી થતું (દા.ત. repair charge, જૂનો hisaab, કે કોઈ બીજી આવક). આ પસંદ કરો ત્યારે એક ચેતવણી (warning) દેખાય છે — “I understand — continue with a manual sale” ચેકબોક્સ ચેક કર્યા પછી જ form ખુલે છે.
            </li>
          </ul>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            ખોટા વિકલ્પ પર entry કરવાથી Stock ખોટો દેખાશે — ખાતરી કરો કે ખરેખર Finished Jewellery stock માંથી piece વેચાય છે ત્યારે જ “Sell Finished Jewellery” પસંદ કરો.
          </p>

          <SubHeading>GST — સાવ સાદી ભાષામાં</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            જ્યારે પણ GST પસંદ કરવાનું આવે, ત્રણ વિકલ્પ મળે છે:
          </p>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li><strong>No GST</strong> — GST લાગુ ના પડે એવો વ્યવહાર.</li>
            <li><strong>CGST + SGST (within state)</strong> — Customer/Supplier આપણા જ રાજ્ય (state) માં હોય ત્યારે.</li>
            <li><strong>IGST (different state)</strong> — Customer/Supplier બીજા રાજ્યમાં હોય ત્યારે.</li>
          </ul>
          <Note>
            કયો GST type વાપરવો એ ખાતરી ના હોય તો Owner ને પૂછો — ખોટો GST type પસંદ કરવાથી હિસાબ ખોટો થાય છે, અને posting થઈ ગયા પછી એ ચૂપચાપ બદલી શકાતું નથી (નીચે જુઓ).
          </Note>

          <SubHeading>Transaction સચવાયું કે નહીં એ કેવી રીતે ખાતરી કરવી</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Save દબાવ્યા પછી લીલા (green) રંગનો message દેખાય — જેમાં “... saved as ...” અને એક number/code હોય (દા.ત. “Sale saved as ZL-FJS-2026-000012.”). આ message ના દેખાય, અથવા લાલ (red) રંગનો error message દેખાય, તો entry સચવાઈ નથી — ફરીથી Save દબાવતાં પહેલાં error વાંચો.
          </p>

          <SubHeading>Posted Transaction ને ચૂપચાપ Edit કેમ ના કરાય</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            એકવાર Save થયેલી (posted) entry ને સીધું બદલી શકાતું નથી — આ ઇરાદાપૂર્વક છે, જેથી હિસાબમાં કોઈ number કોઈના ધ્યાન બહાર ના બદલાય. ખોટી entry સુધારવાનો એકમાત્ર સાચો રસ્તો છે — <strong>Cancel</strong> કરીને પછી સાચી નવી entry બનાવવી (નીચે જુઓ).
          </p>

          <SubHeading>Owner Cancellation / Reversal</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
            <CautionBadge />
          </BadgeRow>
          <Steps>
            <li>Transactions ની yaadi માં ખોટી entry ની બાજુમાં <Btn>Cancel</Btn> દબાવો.</li>
            <li>“Cancellation reason” માં કારણ લખો.</li>
            <li><Btn>Confirm cancel</Btn> દબાવો.</li>
            <li>સોફ્ટવેર આપોઆપ એક “Reversal” entry બનાવશે, જે જૂની entry ને ઊલટાવે (undo કરે) છે — જૂની entry ભૂંસાતી નથી, ફક્ત “Cancelled” તરીકે દેખાય છે.</li>
          </Steps>
          <Note>
            જો entry, Finished Jewellery ના વેચાણ સાથે જોડાયેલી હોય, તો સોફ્ટવેર અહીંથી Cancel નહીં થવા દે — એ કિસ્સામાં “Finished Stock and Sales” section માં બતાવેલી ખાસ રીતે Cancel કરવું પડે.
          </Note>

          <SubHeading id="task-fix-mistake">સામાન્ય ભૂલો અને સાચું પગલું</SubHeading>
          <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <th className="py-2 pr-3">ભૂલ</th>
                <th className="py-2">શું કરવું</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              <tr>
                <td className="py-2 pr-3">ખોટો Customer/Supplier પસંદ થયો</td>
                <td className="py-2">Owner ને જણાવો → entry Cancel કરાવો → સાચી Party સાથે નવી entry બનાવો.</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">ખોટી રકમ ભરાઈ ગઈ</td>
                <td className="py-2">Owner ને જણાવો → entry Cancel કરાવો → સાચી રકમ સાથે નવી entry બનાવો.</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">ખોટો GST type પસંદ થયો</td>
                <td className="py-2">Owner ને જણાવો → entry Cancel કરાવો → સાચા GST સાથે નવી entry બનાવો.</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">Save બે વાર દબાઈ ગયું</td>
                <td className="py-2">ચિંતા ના કરો — સોફ્ટવેર બે વાર entry બનવા દેતું નથી. Transactions ની yaadi માં ચેક કરી ખાતરી કરો.</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "diamond",
      title: "Diamond Manufacturing (Rough → Polished)",
      keywords: [
        "rough", "polished", "diamond", "karigar", "shape", "recut", "lot", "piece",
        "રફ", "પોલિશ્ડ", "ડાયમંડ", "કારીગર",
      ],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading id="task-rough-purchase">New Rough Purchase (Rough Diamond ખરીદવો)</SubHeading>
          <Steps>
            <li>Diamond → Rough Stock પર જાવ.</li>
            <li><Btn>New Rough Purchase</Btn> દબાવો.</li>
            <li>Supplier, તારીખ, Rate, કુલ ખર્ચ (Total purchase cost), અને carat ભરો.</li>
            <li><Btn>Save rough purchase</Btn> દબાવો.</li>
          </Steps>

          <SubHeading>Lot અને Piece નો અર્થ</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <strong>Lot</strong> = એક purchase માં ખરીદેલો આખો rough diamond જથ્થો. <strong>Piece</strong> = એ lot ની અંદરનો દરેક અલગ ટુકડો, જેને અલગ-અલગ Karigar ને issue કરી શકાય. એક Lot ની અંદર એક અથવા વધારે Piece હોઈ શકે.
          </p>

          <SubHeading id="task-issue-rough">Issue Rough — Karigar ને rough આપવો</SubHeading>
          <Steps>
            <li>Diamond → Cutting-Polishing Jobs પર જાવ.</li>
            <li><Btn>Issue Rough</Btn> દબાવો.</li>
            <li>Karigar પસંદ કરો, તારીખ ભરો.</li>
            <li>યાદીમાંથી જે rough piece આપવો હોય એ ✓ ટીક કરો.</li>
            <li><Btn>Required shape</Btn> માં આકાર પસંદ કરો (નીચે જુઓ).</li>
            <li><Btn>Issue Rough</Btn> ફરીથી દબાવીને save કરો.</li>
          </Steps>

          <SubHeading>Standard Shape vs Custom Shape</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <Btn>Required shape</Btn> ની યાદીમાં સામાન્ય shapes (Round, Oval, Pear, Emerald, Cushion, Radiant, Princess, Marquise, Asscher, વગેરે) હોય છે. જો જોઈતો આકાર યાદીમાં ના હોય, છેલ્લે <strong>Custom Shape</strong> પસંદ કરો — ત્યારે નામ, માપ, અને સૂચના (instruction) લખવાના વધારાના બોક્સ ખૂલશે.
          </p>

          <SubHeading>Reference Photo અપલોડ કરવો</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Custom Shape પસંદ કરો ત્યારે <Btn>Reference photo (optional)</Btn> બોક્સ દેખાય છે — ત્યાં ફોટો અપલોડ કરી શકાય (ફરજિયાત નથી). ફોટો jpg/png/webp ફોર્મેટમાં અને 10 MB થી નાનો હોવો જોઈએ.
          </p>

          <SubHeading>Mark In Progress</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Job Issue થયા પછી, Karigar એ કામ ચાલુ કર્યું છે એ બતાવવા <Btn>Mark In Progress</Btn> દબાવી શકાય — આ ફરજિયાત નથી, ફક્ત નોંધ (record) માટે છે.
          </p>
          <BadgeRow>
            <StaffCanBadge />
          </BadgeRow>

          <SubHeading id="task-receive-polished">Receive Polished — Partial અને Final</SubHeading>
          <Steps>
            <li>એ Job ખોલો, <Btn>Receive Polished</Btn> દબાવો.</li>
            <li>Receive date, દરેક polished diamond ના carat/shape/color/clarity ભરો.</li>
            <li>જો પોલિશ કરેલા carat ઉપરાંત કંઈક rough પાછું આવ્યું હોય, <Btn>Returned unused rough carat</Btn> માં એ carat લખો.</li>
            <li>Cutting-polishing labour charge ભરો.</li>
            <li>જો આ Job નું બધું કામ પૂરું થઈ ગયું હોય — હવે Karigar પાસેથી કંઈ પાછું નહીં આવે — તો <Btn>This completes the job — no more rough will come back from this Karigar</Btn> ટીક કરો.</li>
            <li><Btn>Receive Polished</Btn> દબાવીને save કરો.</li>
          </Steps>
          <Note>
            Checkbox ટીક ના કરો તો Job “Partially Received” રહેશે — પછી ફરી “Receive Polished” કરીને બાકીનું ઉમેરી શકાશે. Checkbox ટીક કરો તો Job “Completed” થઈ જશે, અને પછી એમાં કંઈ ઉમેરી શકાશે નહીં.
          </Note>

          <SubHeading>Returned Rough</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Karigar એ વાપર્યા વગરનું જે rough પાછું આપ્યું હોય, એ “Returned unused rough carat” તરીકે નોંધાય છે અને પાછું Available Rough Stock માં ઉમેરાય છે.
          </p>

          <SubHeading>Polished Diamond ના Fields</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            દરેક polished diamond માટે: Shape, Carat, Color, Clarity, Certificate status (Not certified / Internal grade / Certified — Certified હોય તો Lab નામ, Certificate number, અને certificate ફાઈલ પણ ઉમેરી શકાય), અને Photo.
          </p>

          <SubHeading>Recut</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            કોઈ Available polished diamond ફરીથી કાપવો (recut) જરૂરી હોય, તો Polished Stock માં એ diamond ની બાજુમાં <Btn>Mark for recut</Btn> દબાવો, કારણ લખો, <Btn>Confirm</Btn> દબાવો. આ diamond પછી Available Polished Stock માંથી નીકળી જશે (status “Recut” થશે).
          </p>

          <SubHeading>Status નો અર્થ</SubHeading>
          <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">અર્થ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              <tr><td className="py-2 pr-3">Issued</td><td className="py-2">Rough Karigar ને આપી દીધો, હજુ કંઈ પાછું નથી આવ્યું.</td></tr>
              <tr><td className="py-2 pr-3">In Progress</td><td className="py-2">કામ ચાલુ છે એવી નોંધ કરેલી છે.</td></tr>
              <tr><td className="py-2 pr-3">Partially Received</td><td className="py-2">થોડું polished/returned પાછું આવ્યું, પણ હજુ પૂરું બાકી છે.</td></tr>
              <tr><td className="py-2 pr-3">Completed</td><td className="py-2">બધું પૂરેપૂરું પાછું આવી ગયું — Job પૂરો.</td></tr>
              <tr><td className="py-2 pr-3">Cancelled</td><td className="py-2">Job રદ થયો, rough પાછો stock માં ગયો.</td></tr>
            </tbody>
          </table>
          </div>

          <SubHeading>Job ચાલુ હોય ત્યારે શું ના કરવું</SubHeading>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li>Polished diamond receive થઈ ગયા પછી એ Job Cancel કરી શકાતો નથી — ખોટું થયું હોય તો Owner ને જણાવો.</li>
            <li>Completed કે Cancelled Job માં નવો receipt ઉમેરી શકાતો નથી.</li>
            <li>એક જ rough piece બે અલગ Job માં issue ના થાય — સોફ્ટવેર આપોઆપ રોકશે.</li>
          </ul>

          <SubHeading>Job Cancel (Owner)</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Job માં હજુ polished diamond receive ના થયો હોય ત્યાં સુધી જ Owner Job ને Cancel કરી શકે — rough પાછો stock માં આવી જાય છે અને હિસાબ ઊલટાય છે.
          </p>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "metal-jewellery",
      title: "Metal Stock અને Jewellery Jobs",
      keywords: [
        "metal", "purity", "jewellery job", "set", "returned", "needs correction",
        "મેટલ", "જ્વેલરી જોબ", "શુદ્ધતા",
      ],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading>Metal / Purity નો અર્થ</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <strong>Metal</strong> = Gold, Silver કે Platinum. <strong>Purity</strong> = એ metal કેટલું શુદ્ધ છે (દા.ત. Gold 22K, 18K — number જેટલો વધારે, metal એટલું વધારે શુદ્ધ). દરેક purity નો પોતાનો અલગ stock balance હોય છે.
          </p>

          <SubHeading id="task-metal-stock">Purchase અથવા Opening Metal Stock</SubHeading>
          <Steps>
            <li>Jewellery Job → Metal Stock પર જાવ.</li>
            <li>નવો ખરીદેલો માલ હોય તો <Btn>New Metal Purchase</Btn> દબાવો — Supplier, Metal, Purity, વજન (gross weight) અને Rate ભરો.</li>
            <li>જૂનો હાલનો stock પહેલી વાર નોંધવો હોય (ખરીદી નહીં, ફક્ત record) તો <Btn>Opening Metal Stock</Btn> વાપરો.</li>
            <li>Save દબાવો.</li>
          </Steps>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Opening Metal Stock અને Authorized Adjustment ફક્ત Owner કરી શકે. New Metal Purchase Staff પણ કરી શકે.</p>

          <SubHeading id="task-new-jewellery-job">Jewellery Job કેવી રીતે બનાવવો</SubHeading>
          <Steps>
            <li>Jewellery Job → Jewellery Jobs પર જાવ.</li>
            <li><Btn>New Jewellery Job</Btn> દબાવો.</li>
            <li>Design નામ, Karigar, Customer (જો હોય તો), Issue date, Quantity ભરો.</li>
            <li><Btn>Create Jewellery Job</Btn> દબાવો.</li>
          </Steps>

          <SubHeading>Metal, Polished Diamond અને બીજો સામાન Issue કરવો</SubHeading>
          <Steps>
            <li>Job ખોલો, <Btn>Issue Materials</Btn> દબાવો.</li>
            <li>Metal type, Purity, અને gross weight ભરો.</li>
            <li>જે polished diamonds આ job માં વાપરવા હોય એ યાદીમાંથી ✓ ટીક કરો.</li>
            <li>જરૂર હોય તો “More details” ખોલી Other material line (દા.ત. Enamel work) ઉમેરો.</li>
            <li><Btn>Issue Materials</Btn> દબાવીને save કરો.</li>
          </Steps>

          <SubHeading>Mark In Progress</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Material issue થયા પછી, કામ ચાલુ છે એ બતાવવા <Btn>Mark In Progress</Btn> દબાવી શકાય (ફરજિયાત નથી).
          </p>
          <BadgeRow>
            <StaffCanBadge />
          </BadgeRow>

          <SubHeading id="task-receive-finished">Partial અને Final Receipt (Finished Jewellery પાછી લેવી)</SubHeading>
          <Steps>
            <li>Job ખોલો, <Btn>Receive Finished Jewellery</Btn> દબાવો.</li>
            <li>Receive date ભરો.</li>
            <li>દરેક તૈયાર piece (output) નું Net metal weight ભરો.</li>
            <li>જે polished diamonds એ piece માં set (જડેલા) છે એ ✓ ટીક કરો — outcome “SET” ગણાશે.</li>
            <li>વધુ piece બન્યા હોય તો <Btn>+ Add another output</Btn> દબાવીને ઉમેરો.</li>
            <li>Labour/Making/Setting/Plating charge ભરો.</li>
            <li>જો બધું કામ પૂરું થઈ ગયું હોય તો <Btn>This completes the job — no more metal will come back from this Karigar</Btn> ટીક કરો.</li>
            <li><Btn>Receive Finished Jewellery</Btn> દબાવીને save કરો.</li>
          </Steps>

          <SubHeading>Return / Scrap (સાચી Purity સાથે)</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Karigar એ વાપર્યા વગરનું metal પાછું આપ્યું હોય (“Returned unused metal”) અથવા કાપતી વખતે નીકળેલો ભંગાર (scrap) પાછો આપ્યો હોય, તો એ જ purity પસંદ કરીને એનું વજન નોંધો — ખોટી purity પસંદ કરવાથી stock balance ખોટો થઈ જશે.
          </p>
          <BadgeRow>
            <CheckBeforeSaveBadge />
          </BadgeRow>

          <SubHeading>Diamond Outcome — SET અને RETURNED</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li><strong>SET</strong> — diamond ને કોઈ output ના checkbox માં ટીક કરી, jewellery માં જડી દીધો.</li>
            <li><strong>Return to stock (RETURNED)</strong> — diamond પાછો polished stock માં આવે છે, વપરાયો નથી.</li>
            <li><strong>Damaged/Lost (Owner)</strong> — diamond તૂટ્યો/ખોવાયો, ફક્ત Owner આ પસંદ કરી શકે.</li>
            <li><strong>Leave with Karigar</strong> — diamond હજુ Karigar પાસે જ રહે છે, પછીના receipt માં ઉકેલાશે.</li>
          </ul>

          <SubHeading>Job પૂરો કરવાની શરત</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Job ત્યારે જ “Completed” થાય જ્યારે issue કરેલા બધા diamonds નો કોઈ ને કોઈ outcome નક્કી થયો હોય (SET, Returned, કે Damaged/Lost) — કોઈ diamond “Leave with Karigar” તરીકે બાકી હોય ત્યાં સુધી Job પૂરો ના થાય.
          </p>

          <SubHeading>Finished Photo અપલોડ</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            દરેક output માટે <Btn>Finished photo</Btn> બોક્સમાં ફોટો અપલોડ કરી શકાય (jpg/png/webp, 10 MB થી નાનો).
          </p>

          <SubHeading>Needs Correction</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            કંઈક ભૂલ છે અને Job પર કામ રોકવું હોય, તો Job ખોલી <Btn>Mark Needs Correction</Btn> દબાવો — Job ની સ્થિતિ “Needs Correction” થશે, જેથી બીજા કોઈને ખબર પડે કે આમાં કંઈક ચેક કરવાનું બાકી છે. ઠીક થઈ ગયા પછી એ જ જગ્યાએ <Btn>Clear Needs Correction</Btn> દબાવો.
          </p>
          <BadgeRow>
            <StaffCanBadge />
          </BadgeRow>

          <SubHeading>Owner Cancellation</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Job માં હજુ finished jewellery receive ના થઈ હોય ત્યાં સુધી Owner <Btn>Cancel job</Btn> દબાવીને Job રદ કરી શકે — issue કરેલું metal પાછું stock માં, diamonds પાછા Available થાય છે, અને હિસાબ ઊલટાય છે.
          </p>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "finished-stock-sales",
      title: "Finished Stock અને Sales",
      keywords: [
        "finished stock", "sale", "return", "refund", "cancel sale", "available", "sold",
        "તૈયાર જ્વેલરી", "વેચાણ", "રિટર્ન", "રિફંડ",
      ],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading>Available Finished Stock જોવો</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Jewellery Job → Finished Stock tab પર દરેક તૈયાર piece ની યાદી, એનું status, અને (ફક્ત Owner માટે) cost દેખાય છે.
          </p>

          <SubHeading id="task-finished-sale">Finished Jewellery Sale કેવી રીતે બનાવવો</SubHeading>
          <Steps>
            <li>Accounting → Transactions → <Btn>New Sale</Btn> → <Btn>Sell Finished Jewellery</Btn> દબાવો.</li>
            <li>સાચો Customer પસંદ કરો (નવો Customer હોય તો પહેલાં Parties માં ઉમેરો).</li>
            <li>તારીખ ભરો.</li>
            <li>“Add a piece” માંથી વેચવાનો piece પસંદ કરો — ફક્ત Available piece જ યાદીમાં દેખાશે.</li>
            <li>જો એ piece ની Costing finalized હોય, “Use suggested price” બટન દેખાશે — આ ફક્ત સૂચન (suggestion) છે, ખરી selling price તમારે નક્કી કરવાની છે.</li>
            <li>Selling price, Discount (જો હોય તો), GST type, અને Payment account (રોકડ/bank, જો પૈસા તરત મળ્યા હોય) ભરો.</li>
            <li><Btn>Save sale</Btn> દબાવો.</li>
            <li>“Sale saved as ...” message દેખાય એટલે વેચાણ સચવાયું.</li>
          </Steps>
          <Note>
            Suggested price દેખાય તો તે ફક્ત selling price ભરવામાં મદદ માટે છે; સાચી વેચાણ કિંમત માટે Owner ની મંજૂરી લો.
          </Note>

          <SubHeading>એક જ piece બે વાર ના વેચાય એની ખાતરી</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Save બટન ભૂલથી બે વાર દબાઈ જાય, અથવા બે અલગ કોમ્પ્યુટર પર એક જ piece વેચવાની કોશિશ થાય, તો સોફ્ટવેર આપોઆપ ફક્ત એક જ વારને સ્વીકારશે — બીજી કોશિશ “no longer available” જેવો error આપશે. આ error આવે તો ગભરાવાની જરૂર નથી, બીજો piece પસંદ કરો અથવા Refresh કરીને ફરી જુઓ.
          </p>

          <SubHeading id="task-sale-return">Sale Return — Sellable અને Damaged</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <Steps>
            <li>Jewellery Job → Finished Stock નીચે “Finished Jewellery Sales — cancel / return” section માં એ sale શોધો.</li>
            <li>
              Customer પાસેથી piece સારી હાલતમાં પાછો આવ્યો હોય તો <Btn>Return (Sellable)</Btn> દબાવો — piece પાછો Available Stock માં જાય છે, ફરી વેચી શકાય છે.
            </li>
            <li>
              Piece તૂટેલો/ખરાબ થયેલો પાછો આવ્યો હોય (ફરી વેચી ના શકાય એવો) તો <Btn>Return (Damaged)</Btn> દબાવો — piece કાયમ માટે “Returned — Damaged” થઈ જાય છે, ફરી Available નહીં થાય.
            </li>
            <li>Reason લખો, Confirm દબાવો.</li>
          </Steps>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Sellable અને Damaged વચ્ચેની પસંદગી પાછી બદલી શકાતી નથી — ખાતરી કરીને પસંદ કરો.</p>

          <SubHeading id="task-refund">Refund આપવો</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <Steps>
            <li>Accounting → Reports → Receivable & Payable (Outstanding) report ખોલો.</li>
            <li>જે Customer ને પૈસા પાછા આપવાના હોય (Return પછી credit ઊભું થયું હોય) એની બાજુમાં <Btn>Refund</Btn> દબાવો.</li>
            <li>Payment account પસંદ કરો, <Btn>Save refund</Btn> દબાવો.</li>
          </Steps>
          <Note>Refund બટન ફક્ત ત્યારે જ દેખાય જ્યારે એ Customer નું ખરેખર credit balance હોય (આપણે એમને પૈસા આપવાના હોય).</Note>

          <SubHeading>Sale Cancellation</SubHeading>
          <BadgeRow>
            <OwnerOnlyBadge />
            <CautionBadge />
          </BadgeRow>
          <Steps>
            <li>એ જ “Finished Jewellery Sales” section માં sale ની બાજુમાં <Btn>Cancel sale</Btn> દબાવો.</li>
            <li>Reason લખો, <Btn>Confirm cancellation</Btn> દબાવો.</li>
            <li>આખું વેચાણ ઊલટાય છે — piece પાછો Available થાય છે અને સંબંધિત Accounting/GST entries reverse થાય છે.</li>
          </Steps>
          <Note>જો sale નો કોઈ piece પહેલેથી Return થઈ ગયો હોય, તો આખું Sale Cancel નહીં થાય — એ કિસ્સામાં Owner ને જણાવો.</Note>

          <SubHeading>Status નો અર્થ</SubHeading>
          <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">અર્થ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              <tr><td className="py-2 pr-3">Available</td><td className="py-2">વેચવા માટે તૈયાર છે.</td></tr>
              <tr><td className="py-2 pr-3">Sold</td><td className="py-2">વેચાઈ ગયો છે.</td></tr>
              <tr><td className="py-2 pr-3">Returned — Damaged</td><td className="py-2">ખરાબ હાલતમાં પાછો આવ્યો, ફરી વેચી શકાય એમ નથી.</td></tr>
            </tbody>
          </table>
          </div>

          <SubHeading>Stock અને Accounting સાથે જ update થાય છે</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Finished Jewellery Sale/Return/Cancel કરો ત્યારે Stock (Available/Sold) અને Accounting (પૈસાનો હિસાબ) બંને એક જ સાથે, એક જ ક્ષણે update થાય છે — ક્યારેય એક બદલાય અને બીજું ના બદલાય એવું બનતું નથી.
          </p>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "daily-checklist",
      title: "રોજિંદું Checklist",
      keywords: ["checklist", "daily", "start", "end", "ચેકલિસ્ટ", "શરૂ", "પૂરો"],
      body: (
        <div className="flex flex-col gap-4">
          <SubHeading>દરરોજ કામ શરૂ કરતાં પહેલાં</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li>Login કરીને Dashboard ના numbers એક નજર જુઓ — ગઈકાલ કરતાં કંઈ વિચિત્ર તો નથી લાગતું ને.</li>
            <li>ઈન્ટરનેટ/સોફ્ટવેર બરાબર ચાલે છે એની ખાતરી કરો.</li>
          </ul>

          <SubHeading>દરેક entry કરતાં પહેલાં</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li>સાચી Party (Customer/Supplier/Karigar) પસંદ થઈ છે ને ચેક કરો.</li>
            <li>તારીખ અને રકમ બંને ફરી વાંચી લો.</li>
            <li>GST type (No GST / CGST+SGST / IGST) સાચો પસંદ થયો છે ને ચેક કરો.</li>
            <li>Diamond/Metal નું વજન સાચા એકમમાં ભરાયું છે ને ચેક કરો — carat diamond માટે, gram metal માટે.</li>
            <li>Job પર entry કરતાં પહેલાં Job નું status (Draft/In Progress/Completed વગેરે) જુઓ.</li>
            <li>Save દબાવ્યા પછી લીલા રંગનો “... saved as ...” message ખરેખર દેખાયો કે નહીં ચેક કરો.</li>
          </ul>

          <SubHeading>દિવસ પૂરો કરતાં પહેલાં</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li>Dashboard અને Outstanding (Receivable/Payable) report એક વાર ફરી જુઓ.</li>
            <li>આજની બધી entries બરાબર save થઈ છે ને ખાતરી કરો.</li>
            <li>Computer છોડતાં પહેલાં <Btn>Log out</Btn> દબાવવાનું ભૂલશો નહીં.</li>
          </ul>
        </div>
      ),
    },

    // ------------------------------------------------------------------
    {
      id: "troubleshooting",
      title: "સામાન્ય તકલીફો અને ઉકેલ",
      keywords: [
        "problem", "error", "issue", "wrong password", "inactive", "upload", "save not working",
        "તકલીફ", "એરર", "સમસ્યા",
      ],
      body: (
        <div className="flex flex-col gap-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <th className="py-2 pr-3">તકલીફ</th>
                  <th className="py-2 pr-3">શું કરવું</th>
                  <th className="py-2">Owner ને ક્યારે જણાવવું</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] align-top">
                <tr>
                  <td className="py-2 pr-3">ખોટો Password</td>
                  <td className="py-2 pr-3">Email/Password ફરી ધ્યાનથી ટાઈપ કરો (Caps Lock ચેક કરો).</td>
                  <td className="py-2">2-3 વાર ખોટો પડે તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Account Inactive</td>
                  <td className="py-2 pr-3">Login નહીં થાય — તમારું account કોઈએ Deactivate કરેલું છે.</td>
                  <td className="py-2">તરત Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Party યાદીમાં ના દેખાય</td>
                  <td className="py-2 pr-3">એ Party Archive થયેલી હોઈ શકે, અથવા નામ ખોટું ટાઈપ થયું હોય — search ફરી ચેક કરો.</td>
                  <td className="py-2">Party ફરી જોઈએ છે (Reactivate કરવી છે) તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Balance ખોટો/negative દેખાય</td>
                  <td className="py-2 pr-3">પોતાની જાતે કંઈ બદલવાની કોશિશ ના કરો.</td>
                  <td className="py-2">તરત Owner ને જણાવો — ડેટાબેઝમાં સીધો ફેરફાર ક્યારેય જાતે ના કરવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Item “already sold” / no longer available</td>
                  <td className="py-2 pr-3">બીજું કોઈ (અથવા બીજું ટેબ/કોમ્પ્યુટર) એ પહેલેથી વેચી દીધું — Refresh કરી બીજો item પસંદ કરો.</td>
                  <td className="py-2">શંકા હોય તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Rough/Diamond/Metal પસંદ ના થાય</td>
                  <td className="py-2 pr-3">એ item પહેલેથી issue/used/cancelled હોઈ શકે — Refresh કરીને ફરી જુઓ.</td>
                  <td className="py-2">પછી પણ ના દેખાય તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Job Complete ના થાય</td>
                  <td className="py-2 pr-3">કોઈ diamond નું outcome (SET/Returned/Damaged) બાકી હોઈ શકે, અથવા “This completes the job” ટીક કરવાનું રહી ગયું હોય.</td>
                  <td className="py-2">ખાતરી ના થાય તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Image/PDF Upload Rejected</td>
                  <td className="py-2 pr-3">ફાઈલ 10 MB થી મોટી ના હોવી જોઈએ, અને jpg/png/webp (અથવા certificate માટે pdf) ફોર્મેટમાં જ હોવી જોઈએ.</td>
                  <td className="py-2">ફોર્મેટ બરાબર છતાં ના ચાલે તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Save બટન કામ ના કરે એવું લાગે</td>
                  <td className="py-2 pr-3">થોડી સેકંડ રાહ જુઓ (internet ધીમું હોઈ શકે). ફરી-ફરી Save ના દબાવો — એકવાર દબાવીને રાહ જુઓ.</td>
                  <td className="py-2">ઘણી વાર રાહ જોયા પછી પણ કંઈ ના થાય તો Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">ખોટી Entry થઈ ગઈ</td>
                  <td className="py-2 pr-3">પોતાની જાતે કંઈ બદલવાની કોશિશ ના કરો — “Accounting” section માં બતાવેલી Cancel/Reversal રીત વાપરવાની હોય છે.</td>
                  <td className="py-2">તરત Owner ને જણાવો.</td>
                </tr>
                <tr>
                  <td className="py-2 pr-3">Internet/Database ઉપલબ્ધ નથી</td>
                  <td className="py-2 pr-3">થોડીવાર રાહ જુઓ, પછી Refresh કરો. Form માં અધૂરી માહિતી હોય તો સાચવી (નોંધી) રાખો, જેથી ફરી ટાઈપ ના કરવું પડે.</td>
                  <td className="py-2">લાંબો સમય ચાલુ રહે તો Owner ને જણાવો.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <Note>ક્યારેય ડેટાબેઝ કે કોડમાં સીધો ફેરફાર જાતે ના કરવો — કોઈ પણ તકલીફ માટે હંમેશા ઉપર બતાવેલી, સોફ્ટવેરની અંદરની જ રીત વાપરવી, અથવા Owner ને જણાવવું.</Note>
        </div>
      ),
    },
  ];

  // Owner-only sections — computed and rendered ONLY when role === "OWNER".
  // Never included in the array (not even hidden) for a Staff request, so
  // the server never serializes this content into a Staff RSC response.
  if (isOwner) {
    sections.push({
      id: "costing",
      title: "Costing (ફક્ત Owner)",
      ownerOnly: true,
      keywords: ["costing", "cost sheet", "markup", "margin", "quotation", "કોસ્ટિંગ"],
      body: (
        <div className="flex flex-col gap-4">
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            આ આખું section ફક્ત Owner ને દેખાય છે — Staff ને Costing page કે એની કોઈ માહિતી ક્યારેય મોકલવામાં આવતી નથી.
          </p>

          <SubHeading>Actual Costing vs Estimate</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <Btn>New Costing</Btn> દબાવો ત્યારે “What are you costing?” પુછાય: <strong>“A piece we already finished”</strong> (Actual — પહેલેથી બનેલા piece નો ખરો ખર્ચ) અથવા <strong>“An estimate before making it”</strong> (Estimate — બનાવતાં પહેલાંનો અંદાજ).
          </p>

          <SubHeading>Markup vs Target Margin</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Selling price નક્કી કરવાની બે રીત: <strong>Markup on cost</strong> (ખર્ચ ઉપર ટકા ઉમેરવા) અથવા <strong>Target margin on selling price</strong> (વેચાણ કિંમતમાં ચોક્કસ ટકા નફો રહે એ રીતે ગણવું).
          </p>

          <SubHeading>Discount, GST, Fees</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Cost Sheet માં Discount, GST, અને selling expense ઉમેરી શકાય છે — આ બધું ફાઈનલ selling price માં ગણાય છે.
          </p>

          <SubHeading>Draft, Finalize, Revise, Archive</SubHeading>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            <li><strong>Draft</strong> — હજુ ફેરફાર થઈ શકે એવી સ્થિતિ.</li>
            <li><Btn>Finalize</Btn> — કિંમત નક્કી, હવે આ Cost Sheet ફેરવાય નહીં.</li>
            <li><Btn>Revise</Btn> — Finalized sheet ની નવી Draft copy બનાવે (જૂની Finalized સચવાયેલી રહે છે).</li>
            <li><Btn>Archive</Btn> — હવે વાપરવાની ના હોય એવી sheet ને બાજુ પર મૂકવી (delete નહીં); <Btn>Restore from archive</Btn> થી પાછી લાવી શકાય.</li>
          </ul>

          <SubHeading>Quotation</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Finalized Cost Sheet પર <Btn>Open customer quotation</Btn> દબાવીને Customer ને બતાવવા લાયક, સાફ (ખર્ચ/નફો વગરની) quotation જોઈ/print કરી શકાય છે.
          </p>

          <SubHeading>Phase 5 Costing vs Phase 6 Realized Profit</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Finished Stock પર (Costing જોડાયેલી હોય એવા piece માટે) <Btn>Compare vs Costing</Btn> દબાવીને — Costing વખતે ધારેલો નફો, અને ખરેખર વેચાયા પછીનો સાચો નફો — બંને સાથે જોઈ શકાય છે.
          </p>

          <SubHeading>Finalized History બદલાતી નથી</SubHeading>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            એકવાર Finalize થયેલી Cost Sheet ક્યારેય ફરીથી લખાતી (rewrite) નથી — સુધારો જોઈએ તો હંમેશા <Btn>Revise</Btn> દ્વારા નવી Draft બને છે, જૂની history એમની એમ સચવાયેલી રહે છે.
          </p>
        </div>
      ),
    });

    sections.push({
      id: "settings",
      title: "Settings (ફક્ત Owner)",
      ownerOnly: true,
      keywords: ["settings", "staff", "metal purity", "gst rate", "સેટિંગ્સ", "સ્ટાફ"],
      body: (
        <div className="flex flex-col gap-4">
          <BadgeRow>
            <OwnerOnlyBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            આ આખું section ફક્ત Owner ને દેખાય છે.
          </p>

          <SubHeading>Company Details</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">Settings → “Company details” કાર્ડમાં company નું નામ, સરનામું, GST number વગેરે.</p>

          <SubHeading>Staff Account બનાવવો/Deactivate કરવો</SubHeading>
          <Steps>
            <li>Settings → “Staff accounts” → “Add a Staff account” ખોલો.</li>
            <li>Name, Email, Temporary password ભરો.</li>
            <li><Btn>Add staff account</Btn> દબાવો.</li>
            <li>Staff હવે ના જોઈએ (નોકરી છોડી, વગેરે), તો એ જ યાદીમાં <Btn>Deactivate</Btn> દબાવો — Login તરત બંધ થઈ જાય છે, જૂની history સચવાયેલી રહે છે.</li>
          </Steps>
          <Note>
            Deactivate કરેલો Staff પાછો જોઈએ તો <Btn>Reactivate</Btn> દબાવો.
          </Note>

          <SubHeading>Metal/Purity Master</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            “Metal/Purity master (gold, silver, platinum karats)” ખોલીને Gold/Silver/Platinum ની purity યાદી જોઈ/ઉમેરી શકાય છે.
          </p>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">પહેલેથી બનેલી purity ની fineness % બદલવાથી જૂના stock ના હિસાબ પર અસર થઈ શકે — ખાતરી વગર ના બદલો.</p>

          <SubHeading>GST અને Payment Account Settings</SubHeading>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Accounting settings પરથી GST rates અને payment accounts (Cash, Bank, વગેરે) સેટ કરી શકાય છે.
          </p>

          <SubHeading>Owner Credentials ક્યારેય Share ના કરો</SubHeading>
          <BadgeRow>
            <CautionBadge />
          </BadgeRow>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
            Owner નો પોતાનો email/password ક્યારેય કોઈ Staff સાથે share ના કરવો — દરેક Staff માટે અલગ Staff account બનાવો, જેથી કોણે શું કર્યું એ હંમેશા ખબર પડે.
          </p>
        </div>
      ),
    });
  }

  return sections;
}
