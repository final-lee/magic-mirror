import { EventResources, type EventResourceProps } from "./EventResources";
export function Sensors(props: EventResourceProps) {
  return <EventResources {...props} kind="Sensor" />;
}
