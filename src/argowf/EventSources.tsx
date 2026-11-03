import { EventResources, type EventResourceProps } from "./EventResources";
export function EventSources(props: EventResourceProps) {
  return <EventResources {...props} kind="EventSource" />;
}
