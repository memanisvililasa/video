export type QueueJob<TPayload> = {
  id: string;
  payload: TPayload;
  createdAt: string;
};

export async function enqueueJob<TPayload>(_payload: TPayload): Promise<QueueJob<TPayload>> {
  throw new Error("Job queue is not implemented yet.");
}
