// Day 5 Task 7: thin wrapper around the get/set filter state host calls.
// Kept separate from filterStore so the store remains testable without a
// HostBridge stub.

import {
  GET_FILTER_STATE_TYPE,
  SET_FILTER_STATE_TYPE,
  request,
  type FilterState,
  type GetFilterStateRequest,
  type GetFilterStateResponse,
  type HostBridge,
  type SetFilterStateRequest,
  type SetFilterStateResponse,
} from '@unity-index/graph-core';

const FILTER_TIMEOUT_MS = 5_000;

export async function getFilterState(bridge: HostBridge): Promise<FilterState> {
  const res = await request<GetFilterStateRequest, GetFilterStateResponse>(
    bridge,
    GET_FILTER_STATE_TYPE,
    {},
    { timeoutMs: FILTER_TIMEOUT_MS },
  );
  return res.state;
}

export async function setFilterState(
  bridge: HostBridge,
  state: FilterState,
): Promise<void> {
  await request<SetFilterStateRequest, SetFilterStateResponse>(
    bridge,
    SET_FILTER_STATE_TYPE,
    { state },
    { timeoutMs: FILTER_TIMEOUT_MS },
  );
}
