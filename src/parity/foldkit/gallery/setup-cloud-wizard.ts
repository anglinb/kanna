// The setup slice's Kanna Cloud step (src/foldkit/setup with
// settings/cloud-pair.ts), opened the way the Mac app's Put This Mac
// Online… opens it, against the React wizard (gallery/setup-cloud-wizard.tsx).
// A stand-in for the machine's pairing endpoint answers.
import { CLOUD_WIZARD_SNAPSHOT, installFakePairSession } from "../../react/gallery/support/setup-states"
import { wizardHostPage } from "./support/setup-wizard-host"

export default wizardHostPage({
  snapshot: CLOUD_WIZARD_SNAPSHOT,
  open: false,
  cloud: true,
  before: installFakePairSession,
})
