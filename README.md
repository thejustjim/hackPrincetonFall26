# Working vision: affordable water monitoring that leads to action

Build an affordable system that measures water conditions, makes changes understandable across locations and time, and helps people decide what to do next. Demonstrate it through a small sensing device, a dashboard, and sensor-guided filter selection.

This is a synthesis of the discussion's working direction. The group has not fully resolved its intended customer or how much treatment the system should perform.

## The purpose

The original motivation was broader access to frequent water monitoring, particularly for communities with limited infrastructure or cellular coverage. Ethan described the value as collecting approximate readings across many places and times, spotting unusual patterns, and directing experts toward potential problems. That network ambition remains important to the concept's identity.

## How the concepts connect

**Sensing provides the evidence.** The proposed device measures pH, dissolved solids/conductivity, and optical indicators of color or cloudiness. These readings describe particular water properties; the discussion does not establish reliable identification of every contaminant.

**The dashboard makes readings useful.** The latest consolidated plan proposes live gauges, measurement history, before-and-after comparisons, and a 3D Princeton map. It also proposes combining device readings with published water data and approximately 15 clearly labeled simulated nodes.

**Filter selection connects measurement to action.** The hardware direction evolved toward a small array that selects a filter path using a servo. Bharath preferred two slots over three to keep the build manageable, and Jim accepted that choice. Later planning replaced pumped flow with gravity.

**AI explains the results.** The software plan gives AI a concrete role as an explainer alongside readings and history. The discussion leaves the model, its validation, and its authority over physical decisions unresolved.

Together, these form one intended experience: **measure → interpret → choose an action → compare the result**. The hardware produces evidence; the interface explains it; the filtration demonstration shows a possible response.

## Where the direction became clearer

**The group supported pursuing a physical demonstration.** The prototype's communications also changed from planned LoRa hardware to ESP-NOW because the LoRa parts were unavailable. That practical substitution leaves the original long-range network ambition to be demonstrated separately.

**The maintenance claim was challenged.** Ethan pointed out that filters still need replacement; Jim said he thought the earlier maintenance-free premise had been dropped. Bharath subsequently framed the benefit as choosing filters according to the device's readings. The emerging value is less testing and decision burden, with replacement still required.

**Autonomous detection and filtration were described as a future goal.** The current design is a small demonstration of that ambition; the discussion does not verify successful autonomous operation.

## The questions that still affect the vision

- **Who is the primary user?** The earlier direction serves communities and municipal monitoring. Jim later suggested a possible shift toward homeowners, while Ethan still understood the device as belonging in water mains. That shift was raised as a question.
- **What is the primary intervention?** Flagging anomalies for experts, recommending replacement filters, and automatically routing water through filters are related but distinct promises.
- **What can the evidence support?** Sensor interpretation, filter-selection logic, and before-and-after performance still need demonstration. The map should distinguish measured, published, and simulated data.

## Recommended focus for the first demonstration

Show one complete, understandable sequence: test a sample, display its readings, explain the supported finding, select a filter path, and compare the subsequent measurement. Use the map to show how that same process could extend across locations.

Keep affordable monitoring and informed action at the center. Let autonomous treatment and wider deployment remain the longer-term vision.
