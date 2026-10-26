// The setup slice (src/foldkit/setup) as Kanna for Mac shows it, with its
// This Mac step first, against the React wizard (gallery/setup-mac-wizard.tsx).
// A stand-in for the app answers the step's switches.
import { installFakeMacApp, MAC_WIZARD_SNAPSHOT, MAC_WIZARD_START } from "../../gallery-support/setup-states"
import { wizardHostPage } from "./support/setup-wizard-host"

export default wizardHostPage({
  snapshot: MAC_WIZARD_SNAPSHOT,
  open: true,
  // As on the real page: the server can pair, but the fixture answers no session.
  cloud: true,
  before: () => installFakeMacApp(MAC_WIZARD_START),
})
