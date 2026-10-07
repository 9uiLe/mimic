import { setupExperienceFirst } from "../dogfood/experience-first/setup.js";
import { authoredJourneyPlan } from "./plan.js";

export async function setupPrototypeJourney(
  options: { rejectedRequest?: boolean; withModes?: boolean } = {},
) {
  const fixture = await setupExperienceFirst(options);
  return { ...fixture, journeyPlan: authoredJourneyPlan(fixture) };
}
