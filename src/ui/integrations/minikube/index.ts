import { defineVendor } from "../registry";
import { mark } from "./mark";

/**
 * minikube.
 *
 * Labelled LOCAL rather than MINIKUBE: what the reader needs from that
 * column is "this one cannot hurt anybody", not the name of the tool.
 */
export default defineVendor({
  id: "minikube",
  name: "minikube",
  flavours: [
    {
      id: "minikube",
      claims: (name) => name.includes("minikube"),
      label: "LOCAL",
      mark,
    },
  ],
});
