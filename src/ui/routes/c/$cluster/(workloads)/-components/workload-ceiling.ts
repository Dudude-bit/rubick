/**
 * What a workload page hands the Usage block: the template's reservation for
 * one replica, computed in the backend by the rule every pod screen uses
 * (`resources::reservation`) and carried on the workload's own info.
 */
import type { ReplicaReservation } from "@/generated/types";

export type WorkloadTemplate = { replica?: ReplicaReservation | null };
