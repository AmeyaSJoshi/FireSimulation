import math;

obj FrontierEntry {
    has minutes: float;
    has index: int;
}

def clamp(value: float, low: float, high: float) -> float {
    return min(high, max(low, value));
}

def moisture_damping(moisture: float, extinction: float) -> float {
    if extinction <= 0.0 {
        return 0.0;
    }
    ratio: float = clamp(moisture / extinction, 0.0, 1.0);
    if ratio <= 0.0 {
        return 1.0;
    }
    if ratio >= 1.0 {
        return 0.0;
    }
    return max(0.0, 1.0 - 2.59 * ratio + 5.11 * ratio ** 2 - 3.52 * ratio ** 3);
}

# Surface Rothermel kernel. Fuel rows remain raw arrays so every external
# fuel source uses this one Jac contract instead of embedding a second table.
def surface_rate(
    dead_loads: list[float], dead_savs: list[float],
    live_loads: list[float], live_savs: list[float],
    fuel_bed_depth_meters: float, particle_density_kg_per_m3: float,
    total_mineral_fraction: float, effective_mineral_fraction: float,
    heat_content_kj_per_kg: float, dead_extinction: float,
    dead_moisture: float, live_moisture: float,
    dead_moistures: list[float], live_moistures: list[float],
    midflame_wind_kmh: float, wind_direction_radians: float,
    slope_radians: float, slope_aspect_east: float, slope_aspect_north: float,
    travel_east: float, travel_north: float
) -> float {
    if len(dead_loads) != len(dead_savs) or len(live_loads) != len(live_savs)
        or len(dead_loads) != len(dead_moistures) or len(live_loads) != len(live_moistures) {
        return 0.0;
    }
    if fuel_bed_depth_meters <= 0.0 or particle_density_kg_per_m3 <= 0.0
        or dead_extinction <= 0.0 {
        return 0.0;
    }
    total_load: float = 0.0;
    total_surface: float = 0.0;
    dead_surface: float = 0.0;
    live_surface: float = 0.0;
    sigma_numerator: float = 0.0;
    index: int = 0;
    while index < len(dead_loads) {
        load: float = dead_loads[index];
        sav: float = dead_savs[index];
        if load > 0.0 and sav > 0.0 {
            surface: float = load * sav;
            total_load += load;
            total_surface += surface;
            dead_surface += surface;
            sigma_numerator += surface * sav;
        }
        index += 1;
    }
    index = 0;
    while index < len(live_loads) {
        load: float = live_loads[index];
        sav: float = live_savs[index];
        if load > 0.0 and sav > 0.0 {
            surface: float = load * sav;
            total_load += load;
            total_surface += surface;
            live_surface += surface;
            sigma_numerator += surface * sav;
        }
        index += 1;
    }
    if total_load <= 0.0 or total_surface <= 0.0 {
        return 0.0;
    }
    characteristic_dead_moisture: float = dead_moisture;
    if dead_surface > 0.0 {
        characteristic_dead_moisture = 0.0;
        index = 0;
        while index < len(dead_loads) {
            if dead_loads[index] > 0.0 and dead_savs[index] > 0.0 {
                characteristic_dead_moisture += dead_loads[index] * dead_savs[index] * dead_moistures[index] / dead_surface;
            }
            index += 1;
        }
    }
    characteristic_live_moisture: float = live_moisture;
    if live_surface > 0.0 {
        characteristic_live_moisture = 0.0;
        index = 0;
        while index < len(live_loads) {
            if live_loads[index] > 0.0 and live_savs[index] > 0.0 {
                characteristic_live_moisture += live_loads[index] * live_savs[index] * live_moistures[index] / live_surface;
            }
            index += 1;
        }
    }
    if characteristic_dead_moisture >= dead_extinction {
        return 0.0;
    }
    sigma: float = (sigma_numerator / total_surface) * 0.3048;
    if sigma <= 0.0 {
        return 0.0;
    }
    dead_net_load: float = 0.0;
    index = 0;
    while index < len(dead_loads) {
        load: float = dead_loads[index];
        sav: float = dead_savs[index];
        if load > 0.0 and sav > 0.0 and dead_surface > 0.0 {
            dead_net_load += load * (load * sav / dead_surface);
        }
        index += 1;
    }
    dead_net_load *= 1.0 - total_mineral_fraction;
    live_net_load: float = 0.0;
    index = 0;
    while index < len(live_loads) {
        if live_loads[index] > 0.0 and live_savs[index] > 0.0 {
            live_net_load += live_loads[index];
        }
        index += 1;
    }
    live_net_load *= 1.0 - total_mineral_fraction;
    dead_heating: float = 0.0;
    live_heating: float = 0.0;
    index = 0;
    while index < len(dead_loads) {
        if dead_loads[index] > 0.0 and dead_savs[index] > 0.0 {
            dead_heating += dead_loads[index] * math.exp(-138.0 / (dead_savs[index] * 0.3048));
        }
        index += 1;
    }
    index = 0;
    while index < len(live_loads) {
        if live_loads[index] > 0.0 and live_savs[index] > 0.0 {
            live_heating += live_loads[index] * math.exp(-500.0 / (live_savs[index] * 0.3048));
        }
        index += 1;
    }
    live_extinction: float = dead_extinction;
    if dead_heating > 0.0 and live_heating > 0.0 {
        live_extinction = max(dead_extinction, 2.9 * (dead_heating / live_heating)
            * (1.0 - characteristic_dead_moisture / dead_extinction) - 0.226);
    }
    dead_damping: float = moisture_damping(characteristic_dead_moisture, dead_extinction);
    live_damping: float = moisture_damping(characteristic_live_moisture, live_extinction);
    bulk_density_lb_ft3: float = (total_load * 0.2048161436) / (fuel_bed_depth_meters / 0.3048);
    particle_density_lb_ft3: float = particle_density_kg_per_m3 * 0.0624279606;
    packing_ratio: float = bulk_density_lb_ft3 / particle_density_lb_ft3;
    optimum_packing: float = 3.348 * sigma ** -0.8189;
    packing_ratio_ratio: float = packing_ratio / optimum_packing;
    reaction_a: float = 133.0 * sigma ** -0.7913;
    max_reaction: float = sigma ** 1.5 / (495.0 + 0.0594 * sigma ** 1.5);
    reaction_velocity: float = max_reaction * packing_ratio_ratio ** reaction_a
        * math.exp(reaction_a * (1.0 - packing_ratio_ratio));
    mineral_damping: float = min(1.0, 0.174 * effective_mineral_fraction ** -0.19);
    heat_sink: float = 0.0;
    index = 0;
    while index < len(dead_loads) {
        if dead_loads[index] > 0.0 and dead_savs[index] > 0.0 and dead_surface > 0.0 {
            heat_sink += (dead_surface / total_surface) * (dead_loads[index] * dead_savs[index] / dead_surface)
                * (250.0 + 1116.0 * dead_moistures[index]) * math.exp(-138.0 / (dead_savs[index] * 0.3048));
        }
        index += 1;
    }
    index = 0;
    while index < len(live_loads) {
        if live_loads[index] > 0.0 and live_savs[index] > 0.0 and live_surface > 0.0 {
            heat_sink += (live_surface / total_surface) * (live_loads[index] * live_savs[index] / live_surface)
                * (250.0 + 1116.0 * live_moistures[index]) * math.exp(-138.0 / (live_savs[index] * 0.3048));
        }
        index += 1;
    }
    if heat_sink <= 0.0 or bulk_density_lb_ft3 <= 0.0 {
        return 0.0;
    }
    heat_btu_lb: float = heat_content_kj_per_kg * 0.429922614;
    reaction_intensity: float = reaction_velocity * (
        dead_net_load * 0.2048161436 * heat_btu_lb * dead_damping
        + live_net_load * 0.2048161436 * heat_btu_lb * live_damping
    ) * mineral_damping;
    flux_ratio: float = math.exp((0.792 + 0.681 * math.sqrt(sigma)) * (packing_ratio + 0.1)) / (192.0 + 0.2595 * sigma);
    base_rate: float = reaction_intensity * flux_ratio / (bulk_density_lb_ft3 * heat_sink) * 0.3048;
    travel_length: float = math.hypot(travel_east, travel_north);
    if travel_length <= 0.0 {
        return 0.0;
    }
    travel_east /= travel_length;
    travel_north /= travel_length;
    wind_east: float = math.cos(wind_direction_radians);
    wind_north: float = math.sin(wind_direction_radians);
    wind_alignment: float = max(0.0, travel_east * wind_east + travel_north * wind_north);
    wind_phi: float = 0.0;
    if midflame_wind_kmh > 0.0 and wind_alignment > 0.0 {
        wind_c: float = 7.47 * math.exp(-0.133 * sigma ** 0.55);
        wind_b: float = 0.02526 * sigma ** 0.54;
        wind_e: float = 0.715 * math.exp(-0.000359 * sigma);
        wind_phi = wind_c * ((midflame_wind_kmh * (1000.0 / 60.0) * wind_alignment / 0.3048) ** wind_b)
            * packing_ratio_ratio ** -wind_e;
    }
    slope_length: float = math.hypot(slope_aspect_east, slope_aspect_north);
    slope_phi: float = 0.0;
    if slope_radians > 0.0 and slope_length > 0.0 {
        slope_alignment: float = max(0.0, (travel_east * slope_aspect_east + travel_north * slope_aspect_north) / slope_length);
        slope_phi = 5.275 * packing_ratio ** -0.3 * (math.tan(slope_radians) * slope_alignment) ** 2;
    }
    return max(0.0, base_rate * (1.0 + wind_phi + slope_phi));
}

def heap_push(heap: list[FrontierEntry], item: FrontierEntry) {
    heap.append(item);
    position: int = len(heap) - 1;
    while position > 0 {
        parent: int = (position - 1) // 2;
        if heap[parent].minutes <= item.minutes {
            break;
        }
        heap[position] = heap[parent];
        position = parent;
    }
    heap[position] = item;
}

def heap_pop(heap: list[FrontierEntry]) -> FrontierEntry {
    first: FrontierEntry = heap[0];
    tail: FrontierEntry = heap.pop();
    if len(heap) == 0 {
        return first;
    }
    position: int = 0;
    while True {
        left: int = position * 2 + 1;
        right: int = left + 1;
        if left >= len(heap) {
            break;
        }
        child: int = right if right < len(heap) and heap[right].minutes < heap[left].minutes else left;
        if heap[child].minutes >= tail.minutes {
            break;
        }
        heap[position] = heap[child];
        position = child;
    }
    heap[position] = tail;
    return first;
}

def weighted_arrivals(
    rates: list[float], grid_size: int, cell_size_meters: float, ignition_index: int
) -> list[float] {
    total_cells = grid_size * grid_size;
    if grid_size < 2 or len(rates) != total_cells or ignition_index < 0 or ignition_index >= total_cells {
        return [];
    }
    arrivals: list[float] = [];
    for index in range(total_cells) {
        arrivals.append(-1.0);
    }
    arrivals[ignition_index] = 0.0;
    queue: list[FrontierEntry] = [FrontierEntry(minutes=0.0, index=ignition_index)];
    while len(queue) > 0 {
        current: FrontierEntry = heap_pop(queue);
        minutes: float = current.minutes;
        index: int = current.index;
        if minutes != arrivals[index] {
            continue;
        }
        row: int = index // grid_size;
        col: int = index % grid_size;
        for row_delta in [-1, 0, 1] {
            for col_delta in [-1, 0, 1] {
                if row_delta == 0 and col_delta == 0 {
                    continue;
                }
                next_row: int = row + row_delta;
                next_col: int = col + col_delta;
                if next_row < 0 or next_row >= grid_size or next_col < 0 or next_col >= grid_size {
                    continue;
                }
                next_index: int = next_row * grid_size + next_col;
                rate: float = rates[next_index];
                if rate <= 0.0 {
                    continue;
                }
                distance: float = cell_size_meters * (1.41421356237 if row_delta != 0 and col_delta != 0 else 1.0);
                candidate: float = minutes + distance / rate;
                if arrivals[next_index] < 0.0 or candidate < arrivals[next_index] {
                    arrivals[next_index] = candidate;
                    heap_push(queue, FrontierEntry(minutes=candidate, index=next_index));
                }
            }
        }
    }
    return arrivals;
}

def model_rate(
    model_index: int,
    dead_loads_by_model: list[list[float]], dead_savs_by_model: list[list[float]],
    live_loads_by_model: list[list[float]], live_savs_by_model: list[list[float]],
    fuel_bed_depths: list[float], particle_densities: list[float],
    total_minerals: list[float], effective_minerals: list[float],
    heat_contents: list[float], dead_extinctions: list[float], midflame_winds_by_model: list[float],
    dead_moistures_by_model: list[list[float]], live_moistures_by_model: list[list[float]],
    dead_moisture: float, live_moisture: float, wind_direction_radians: float,
    slope_radians: float, slope_aspect_east: float, slope_aspect_north: float,
    travel_east: float, travel_north: float
) -> float {
    if model_index < 0 or model_index >= len(fuel_bed_depths) or model_index >= len(midflame_winds_by_model)
        or model_index >= len(dead_moistures_by_model) or model_index >= len(live_moistures_by_model) {
        return 0.0;
    }
    base_rate: float = surface_rate(
        dead_loads_by_model[model_index], dead_savs_by_model[model_index],
        live_loads_by_model[model_index], live_savs_by_model[model_index],
        fuel_bed_depths[model_index], particle_densities[model_index],
        total_minerals[model_index], effective_minerals[model_index],
        heat_contents[model_index], dead_extinctions[model_index],
        dead_moisture, live_moisture, dead_moistures_by_model[model_index], live_moistures_by_model[model_index], 0.0, wind_direction_radians,
        0.0, 0.0, 0.0, 1.0, 0.0
    );
    if base_rate <= 0.0 {
        return 0.0;
    }
    wind_east: float = math.cos(wind_direction_radians);
    wind_north: float = math.sin(wind_direction_radians);
    wind_head: float = surface_rate(
        dead_loads_by_model[model_index], dead_savs_by_model[model_index],
        live_loads_by_model[model_index], live_savs_by_model[model_index],
        fuel_bed_depths[model_index], particle_densities[model_index],
        total_minerals[model_index], effective_minerals[model_index],
        heat_contents[model_index], dead_extinctions[model_index],
        dead_moisture, live_moisture, dead_moistures_by_model[model_index], live_moistures_by_model[model_index], midflame_winds_by_model[model_index], wind_direction_radians,
        0.0, 0.0, 0.0, wind_east, wind_north
    );
    wind_phi: float = max(0.0, wind_head / base_rate - 1.0);
    aspect_length: float = math.hypot(slope_aspect_east, slope_aspect_north);
    slope_east: float = slope_aspect_east / aspect_length if aspect_length > 0.0 else 0.0;
    slope_north: float = slope_aspect_north / aspect_length if aspect_length > 0.0 else 0.0;
    slope_head: float = surface_rate(
        dead_loads_by_model[model_index], dead_savs_by_model[model_index],
        live_loads_by_model[model_index], live_savs_by_model[model_index],
        fuel_bed_depths[model_index], particle_densities[model_index],
        total_minerals[model_index], effective_minerals[model_index],
        heat_contents[model_index], dead_extinctions[model_index],
        dead_moisture, live_moisture, dead_moistures_by_model[model_index], live_moistures_by_model[model_index], 0.0, wind_direction_radians,
        slope_radians, slope_aspect_east, slope_aspect_north, slope_east, slope_north
    );
    slope_phi: float = max(0.0, slope_head / base_rate - 1.0);
    # This is the same vector sum used by the JS surface kernel before it
    # derives the Rothermel head/backing ellipse.
    force_east: float = wind_phi * wind_east + slope_phi * slope_east;
    force_north: float = wind_phi * wind_north + slope_phi * slope_north;
    force_length: float = math.hypot(force_east, force_north);
    if force_length <= 0.0 {
        force_east = 1.0;
        force_north = 0.0;
    } else {
        force_east /= force_length;
        force_north /= force_length;
    }
    head: float = surface_rate(
        dead_loads_by_model[model_index], dead_savs_by_model[model_index],
        live_loads_by_model[model_index], live_savs_by_model[model_index],
        fuel_bed_depths[model_index], particle_densities[model_index],
        total_minerals[model_index], effective_minerals[model_index],
        heat_contents[model_index], dead_extinctions[model_index],
        dead_moisture, live_moisture, dead_moistures_by_model[model_index], live_moistures_by_model[model_index], midflame_winds_by_model[model_index], wind_direction_radians,
        slope_radians, slope_aspect_east, slope_aspect_north, force_east, force_north
    );
    backing: float = surface_rate(
        dead_loads_by_model[model_index], dead_savs_by_model[model_index],
        live_loads_by_model[model_index], live_savs_by_model[model_index],
        fuel_bed_depths[model_index], particle_densities[model_index],
        total_minerals[model_index], effective_minerals[model_index],
        heat_contents[model_index], dead_extinctions[model_index],
        dead_moisture, live_moisture, dead_moistures_by_model[model_index], live_moistures_by_model[model_index], midflame_winds_by_model[model_index], wind_direction_radians,
        slope_radians, slope_aspect_east, slope_aspect_north, -force_east, -force_north
    );
    if backing > head {
        temporary: float = head;
        head = backing;
        backing = temporary;
    }
    if head <= 0.0 {
        return 0.0;
    }
    alignment: float = clamp(force_east * travel_east + force_north * travel_north, -1.0, 1.0);
    eccentricity: float = (head - backing) / (head + backing);
    denominator: float = 1.0 - eccentricity * alignment;
    if denominator <= 0.0 {
        return 0.0;
    }
    return head * (1.0 - eccentricity) / denominator;
}

def weather_index(weather_minutes: list[float], minutes: float) -> int {
    if len(weather_minutes) == 0 {
        return -1;
    }
    if len(weather_minutes) > 1 and minutes >= weather_minutes[len(weather_minutes) - 1] - 0.000000001 {
        return -1;
    }
    index: int = 0;
    while index + 1 < len(weather_minutes) and weather_minutes[index + 1] <= minutes {
        index += 1;
    }
    return index;
}

def next_weather_boundary(weather_minutes: list[float], minutes: float) -> float {
    index: int = 0;
    while index < len(weather_minutes) {
        if weather_minutes[index] > minutes + 0.000000001 {
            return weather_minutes[index];
        }
        index += 1;
    }
    return 1000000000000000000.0;
}

# A weather row is linearly interpolated between archived observations. The
# caller integrates the resulting rate over short 10-minute segments so a fire
# can change behavior as wind and fuel moisture evolve.
def weather_model_rate(
    model_index: int,
    dead_loads_by_model: list[list[float]], dead_savs_by_model: list[list[float]],
    live_loads_by_model: list[list[float]], live_savs_by_model: list[list[float]],
    fuel_bed_depths: list[float], particle_densities: list[float],
    total_minerals: list[float], effective_minerals: list[float],
    heat_contents: list[float], dead_extinctions: list[float], midflame_winds_by_model: list[float],
    dead_moistures_by_model: list[list[float]], live_moistures_by_model: list[list[float]],
    dead_moisture: float, live_moisture: float, wind_direction_radians: float,
    slope_radians: float, slope_aspect_east: float, slope_aspect_north: float,
    travel_east: float, travel_north: float,
    weather_minutes: list[float], weather_wind_easts_by_time: list[float],
    weather_wind_norths_by_time: list[float], weather_midflame_winds_by_time: list[list[float]],
    weather_dead_moistures_by_time: list[list[list[float]]],
    weather_live_moistures_by_time: list[list[list[float]]], minutes: float
) -> float {
    if len(weather_minutes) == 0 {
        return model_rate(
            model_index, dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
            fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
            heat_contents, dead_extinctions, midflame_winds_by_model,
            dead_moistures_by_model, live_moistures_by_model,
            dead_moisture, live_moisture, wind_direction_radians, slope_radians,
            slope_aspect_east, slope_aspect_north, travel_east, travel_north
        );
    }
    if len(weather_wind_easts_by_time) != len(weather_minutes)
        or len(weather_wind_norths_by_time) != len(weather_minutes)
        or len(weather_midflame_winds_by_time) != len(weather_minutes)
        or len(weather_dead_moistures_by_time) != len(weather_minutes)
        or len(weather_live_moistures_by_time) != len(weather_minutes) {
        return 0.0;
    }
    lower: int = weather_index(weather_minutes, minutes);
    if lower < 0 or model_index < 0 or model_index >= len(midflame_winds_by_model) {
        return 0.0;
    }
    upper: int = min(lower + 1, len(weather_minutes) - 1);
    span: float = weather_minutes[upper] - weather_minutes[lower];
    amount: float = (minutes - weather_minutes[lower]) / span if span > 0.0 else 0.0;
    wind_east: float = weather_wind_easts_by_time[lower]
        + (weather_wind_easts_by_time[upper] - weather_wind_easts_by_time[lower]) * amount;
    wind_north: float = weather_wind_norths_by_time[lower]
        + (weather_wind_norths_by_time[upper] - weather_wind_norths_by_time[lower]) * amount;
    resolved_direction: float = math.atan2(wind_north, wind_east);
    resolved_winds: list[float] = [];
    for index in range(len(midflame_winds_by_model)) {
        if index >= len(weather_midflame_winds_by_time[lower]) or index >= len(weather_midflame_winds_by_time[upper]) {
            return 0.0;
        }
        resolved_winds.append(weather_midflame_winds_by_time[lower][index]
            + (weather_midflame_winds_by_time[upper][index] - weather_midflame_winds_by_time[lower][index]) * amount);
    }
    resolved_dead: list[list[float]] = [];
    resolved_live: list[list[float]] = [];
    for index in range(len(dead_moistures_by_model)) {
        if index >= len(weather_dead_moistures_by_time[lower]) or index >= len(weather_dead_moistures_by_time[upper])
            or index >= len(weather_live_moistures_by_time[lower]) or index >= len(weather_live_moistures_by_time[upper]) {
            return 0.0;
        }
        dead_rows: list[float] = [];
        for row in range(len(dead_moistures_by_model[index])) {
            if row >= len(weather_dead_moistures_by_time[lower][index]) or row >= len(weather_dead_moistures_by_time[upper][index]) {
                return 0.0;
            }
            dead_rows.append(weather_dead_moistures_by_time[lower][index][row]
                + (weather_dead_moistures_by_time[upper][index][row] - weather_dead_moistures_by_time[lower][index][row]) * amount);
        }
        live_rows: list[float] = [];
        for row in range(len(live_moistures_by_model[index])) {
            if row >= len(weather_live_moistures_by_time[lower][index]) or row >= len(weather_live_moistures_by_time[upper][index]) {
                return 0.0;
            }
            live_rows.append(weather_live_moistures_by_time[lower][index][row]
                + (weather_live_moistures_by_time[upper][index][row] - weather_live_moistures_by_time[lower][index][row]) * amount);
        }
        resolved_dead.append(dead_rows);
        resolved_live.append(live_rows);
    }
    return model_rate(
        model_index, dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
        fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
        heat_contents, dead_extinctions, resolved_winds,
        resolved_dead, resolved_live,
        dead_moisture, live_moisture, resolved_direction, slope_radians,
        slope_aspect_east, slope_aspect_north, travel_east, travel_north
    );
}

def rothermel_arrivals(
    fuel_model_indices: list[int], terrain_heights: list[float],
    dead_loads_by_model: list[list[float]], dead_savs_by_model: list[list[float]],
    live_loads_by_model: list[list[float]], live_savs_by_model: list[list[float]],
    dead_moistures_by_model: list[list[float]], live_moistures_by_model: list[list[float]],
    fuel_bed_depths: list[float], particle_densities: list[float],
    total_minerals: list[float], effective_minerals: list[float],
    heat_contents: list[float], dead_extinctions: list[float], midflame_winds_by_model: list[float], burnable_by_model: list[int],
    dead_moisture: float, live_moisture: float, wind_direction_radians: float,
    weather_minutes: list[float], weather_wind_easts_by_time: list[float],
    weather_wind_norths_by_time: list[float], weather_midflame_winds_by_time: list[list[float]],
    weather_dead_moistures_by_time: list[list[list[float]]],
    weather_live_moistures_by_time: list[list[list[float]]],
    grid_size: int, cell_size_meters: float, ignition_index: int, max_propagation_minutes: float
) -> list[float] {
    total_cells: int = grid_size * grid_size;
    if grid_size < 2 or cell_size_meters <= 0.0 or max_propagation_minutes <= 0.0 or len(fuel_model_indices) != total_cells
        or len(terrain_heights) != total_cells or ignition_index < 0 or ignition_index >= total_cells {
        return [];
    }
    arrivals: list[float] = [];
    for index in range(total_cells) {
        arrivals.append(-1.0);
    }
    ignition_model: int = fuel_model_indices[ignition_index];
    if ignition_model < 0 or ignition_model >= len(burnable_by_model) or burnable_by_model[ignition_model] != 1 {
        return arrivals;
    }
    arrivals[ignition_index] = 0.0;
    queue: list[FrontierEntry] = [FrontierEntry(minutes=0.0, index=ignition_index)];
    while len(queue) > 0 {
        current: FrontierEntry = heap_pop(queue);
        minutes: float = current.minutes;
        index: int = current.index;
        if minutes != arrivals[index] {
            continue;
        }
        row: int = index // grid_size;
        col: int = index % grid_size;
        row_north: int = max(0, row - 1);
        row_south: int = min(grid_size - 1, row + 1);
        col_west: int = max(0, col - 1);
        col_east: int = min(grid_size - 1, col + 1);
        east_span: float = (col_east - col_west) * cell_size_meters;
        north_span: float = (row_south - row_north) * cell_size_meters;
        dz_east: float = (terrain_heights[row * grid_size + col_east]
            - terrain_heights[row * grid_size + col_west]) / east_span if east_span > 0.0 else 0.0;
        dz_north: float = (terrain_heights[row_north * grid_size + col]
            - terrain_heights[row_south * grid_size + col]) / north_span if north_span > 0.0 else 0.0;
        gradient: float = math.hypot(dz_east, dz_north);
        current_slope: float = math.atan(gradient);
        current_aspect_east: float = dz_east / gradient if gradient > 0.0 else 0.0;
        current_aspect_north: float = dz_north / gradient if gradient > 0.0 else 0.0;
        for row_delta in [-1, 0, 1] {
            for col_delta in [-1, 0, 1] {
                if row_delta == 0 and col_delta == 0 {
                    continue;
                }
                next_row: int = row + row_delta;
                next_col: int = col + col_delta;
                if next_row < 0 or next_row >= grid_size or next_col < 0 or next_col >= grid_size {
                    continue;
                }
                next_index: int = next_row * grid_size + next_col;
                diagonal: bool = row_delta != 0 and col_delta != 0;
                distance: float = cell_size_meters * (1.41421356237 if diagonal else 1.0);
                travel_east: float = col_delta / (1.41421356237 if diagonal else 1.0);
                travel_north: float = -row_delta / (1.41421356237 if diagonal else 1.0);
                travel_minutes: float = -1.0;
                if len(weather_minutes) <= 1 {
                    rate: float = weather_model_rate(
                        fuel_model_indices[next_index],
                        dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                        fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                        heat_contents, dead_extinctions, midflame_winds_by_model,
                        dead_moistures_by_model, live_moistures_by_model,
                        dead_moisture, live_moisture, wind_direction_radians, current_slope,
                        current_aspect_east, current_aspect_north, travel_east, travel_north,
                        weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                        weather_dead_moistures_by_time, weather_live_moistures_by_time, minutes
                    );
                    if rate > 0.0 {
                        travel_minutes = distance / rate;
                    }
                } else {
                    remaining_distance: float = distance;
                    cursor: float = minutes;
                    segment_count: int = 0;
                    while remaining_distance > 0.000000001 and segment_count < 10000 {
                        boundary: float = min(cursor + 10.0, next_weather_boundary(weather_minutes, cursor));
                        if boundary <= cursor + 0.000000001 {
                            break;
                        }
                        start_rate: float = weather_model_rate(
                            fuel_model_indices[next_index], dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                            fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                            heat_contents, dead_extinctions, midflame_winds_by_model, dead_moistures_by_model, live_moistures_by_model,
                            dead_moisture, live_moisture, wind_direction_radians, current_slope, current_aspect_east, current_aspect_north,
                            travel_east, travel_north, weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                            weather_dead_moistures_by_time, weather_live_moistures_by_time, cursor
                        );
                        end_rate: float = weather_model_rate(
                            fuel_model_indices[next_index], dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                            fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                            heat_contents, dead_extinctions, midflame_winds_by_model, dead_moistures_by_model, live_moistures_by_model,
                            dead_moisture, live_moisture, wind_direction_radians, current_slope, current_aspect_east, current_aspect_north,
                            travel_east, travel_north, weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                            weather_dead_moistures_by_time, weather_live_moistures_by_time, boundary
                        );
                        midpoint: float = cursor + (boundary - cursor) / 2.0;
                        midpoint_rate: float = weather_model_rate(
                            fuel_model_indices[next_index], dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                            fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                            heat_contents, dead_extinctions, midflame_winds_by_model, dead_moistures_by_model, live_moistures_by_model,
                            dead_moisture, live_moisture, wind_direction_radians, current_slope, current_aspect_east, current_aspect_north,
                            travel_east, travel_north, weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                            weather_dead_moistures_by_time, weather_live_moistures_by_time, midpoint
                        );
                        if start_rate <= 0.0 or midpoint_rate <= 0.0 or end_rate <= 0.0 {
                            break;
                        }
                        segment_minutes: float = boundary - cursor;
                        segment_distance: float = segment_minutes * (start_rate + 4.0 * midpoint_rate + end_rate) / 6.0;
                        if segment_distance <= 0.0 {
                            break;
                        }
                        if remaining_distance <= segment_distance {
                            lower: float = 0.0;
                            upper: float = segment_minutes;
                            for iteration in range(16) {
                                candidate_minutes: float = (lower + upper) / 2.0;
                                candidate_midpoint: float = cursor + candidate_minutes / 2.0;
                                candidate_end: float = cursor + candidate_minutes;
                                candidate_mid_rate: float = weather_model_rate(
                                    fuel_model_indices[next_index], dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                                    fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                                    heat_contents, dead_extinctions, midflame_winds_by_model, dead_moistures_by_model, live_moistures_by_model,
                                    dead_moisture, live_moisture, wind_direction_radians, current_slope, current_aspect_east, current_aspect_north,
                                    travel_east, travel_north, weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                                    weather_dead_moistures_by_time, weather_live_moistures_by_time, candidate_midpoint
                                );
                                candidate_end_rate: float = weather_model_rate(
                                    fuel_model_indices[next_index], dead_loads_by_model, dead_savs_by_model, live_loads_by_model, live_savs_by_model,
                                    fuel_bed_depths, particle_densities, total_minerals, effective_minerals,
                                    heat_contents, dead_extinctions, midflame_winds_by_model, dead_moistures_by_model, live_moistures_by_model,
                                    dead_moisture, live_moisture, wind_direction_radians, current_slope, current_aspect_east, current_aspect_north,
                                    travel_east, travel_north, weather_minutes, weather_wind_easts_by_time, weather_wind_norths_by_time, weather_midflame_winds_by_time,
                                    weather_dead_moistures_by_time, weather_live_moistures_by_time, candidate_end
                                );
                                candidate_distance: float = candidate_minutes * (start_rate + 4.0 * candidate_mid_rate + candidate_end_rate) / 6.0;
                                if candidate_distance >= remaining_distance {
                                    upper += candidate_minutes - upper;
                                } else {
                                    lower += candidate_minutes - lower;
                                }
                            }
                            travel_minutes = cursor - minutes + (lower + upper) / 2.0;
                            remaining_distance = 0.0;
                        } else {
                            remaining_distance -= segment_distance;
                            cursor += boundary - cursor;
                        }
                        segment_count += 1;
                    }
                }
                if travel_minutes <= 0.0 {
                    continue;
                }
                candidate: float = minutes + travel_minutes;
                if candidate > max_propagation_minutes {
                    continue;
                }
                if arrivals[next_index] < 0.0 or candidate < arrivals[next_index] {
                    arrivals[next_index] = candidate;
                    heap_push(queue, FrontierEntry(minutes=candidate, index=next_index));
                }
            }
        }
    }
    return arrivals;
}

node FireCell {
    has index: int;
}

walker:pub SurfaceRate {
    has dead_loads: list[float];
    has dead_savs: list[float];
    has live_loads: list[float];
    has live_savs: list[float];
    has fuel_bed_depth_meters: float;
    has particle_density_kg_per_m3: float;
    has total_mineral_fraction: float;
    has effective_mineral_fraction: float;
    has heat_content_kj_per_kg: float;
    has dead_extinction: float;
    has dead_moisture: float;
    has live_moisture: float;
    has dead_moistures: list[float];
    has live_moistures: list[float];
    has midflame_wind_kmh: float;
    has wind_direction_radians: float;
    has slope_radians: float;
    has slope_aspect_east: float;
    has slope_aspect_north: float;
    has travel_east: float;
    has travel_north: float;

    can calculate with Root entry {
        report {
            "rateMPerMin": surface_rate(
                self.dead_loads, self.dead_savs, self.live_loads, self.live_savs,
                self.fuel_bed_depth_meters, self.particle_density_kg_per_m3,
                self.total_mineral_fraction, self.effective_mineral_fraction,
                self.heat_content_kj_per_kg, self.dead_extinction,
                self.dead_moisture, self.live_moisture, self.dead_moistures, self.live_moistures,
                self.midflame_wind_kmh, self.wind_direction_radians,
                self.slope_radians, self.slope_aspect_east, self.slope_aspect_north,
                self.travel_east, self.travel_north
            )
        };
    }
}

walker:pub RunFire {
    has fuel_model_indices: list[int];
    has terrain_heights: list[float];
    has dead_loads_by_model: list[list[float]];
    has dead_savs_by_model: list[list[float]];
    has live_loads_by_model: list[list[float]];
    has live_savs_by_model: list[list[float]];
    has dead_moistures_by_model: list[list[float]];
    has live_moistures_by_model: list[list[float]];
    has fuel_bed_depths: list[float];
    has particle_densities: list[float];
    has total_minerals: list[float];
    has effective_minerals: list[float];
    has heat_contents: list[float];
    has dead_extinctions: list[float];
    has midflame_winds_by_model: list[float];
    has burnable_by_model: list[int];
    has dead_moisture: float;
    has live_moisture: float;
    has wind_direction_radians: float;
    has grid_size: int;
    has cell_size_meters: float;
    has ignition_index: int;
    has max_propagation_minutes: float;
    has weather_minutes: list[float] = [];
    has weather_wind_easts_by_time: list[float] = [];
    has weather_wind_norths_by_time: list[float] = [];
    has weather_midflame_winds_by_time: list[list[float]] = [];
    has weather_dead_moistures_by_time: list[list[list[float]]] = [];
    has weather_live_moistures_by_time: list[list[list[float]]] = [];

    can calculate with Root entry {
        arrivals = rothermel_arrivals(
            self.fuel_model_indices, self.terrain_heights,
            self.dead_loads_by_model, self.dead_savs_by_model,
            self.live_loads_by_model, self.live_savs_by_model,
            self.dead_moistures_by_model, self.live_moistures_by_model,
            self.fuel_bed_depths, self.particle_densities,
            self.total_minerals, self.effective_minerals,
            self.heat_contents, self.dead_extinctions, self.midflame_winds_by_model, self.burnable_by_model,
            self.dead_moisture, self.live_moisture, self.wind_direction_radians,
            self.weather_minutes, self.weather_wind_easts_by_time, self.weather_wind_norths_by_time, self.weather_midflame_winds_by_time,
            self.weather_dead_moistures_by_time, self.weather_live_moistures_by_time,
            self.grid_size, self.cell_size_meters, self.ignition_index, self.max_propagation_minutes
        );
        report {
            "arrivalMinutes": arrivals,
            "model": "jac-rothermel-directional",
            "error": "invalid fire request" if len(arrivals) == 0 else None
        };
    }
}

walker:pub Propagate {
    has rates: list[float];
    has grid_size: int;
    has cell_size_meters: float;
    has ignition_index: int;
    has seen: list[int] = [];

    can initialize with Root entry {
        total_cells = self.grid_size * self.grid_size;
        if self.grid_size < 2 or len(self.rates) != total_cells {
            report {"arrivalMinutes": [], "error": "invalid propagation request"};
            disengage;
        }
        cells: list[FireCell] = [];
        for index in range(total_cells) {
            cells.append(FireCell(index=index));
        }
        for index in range(total_cells) {
            row = index // self.grid_size;
            col = index % self.grid_size;
            for row_delta in [-1, 0, 1] {
                for col_delta in [-1, 0, 1] {
                    if row_delta == 0 and col_delta == 0 {
                        continue;
                    }
                    next_row = row + row_delta;
                    next_col = col + col_delta;
                    if next_row >= 0 and next_row < self.grid_size and next_col >= 0 and next_col < self.grid_size {
                        cells[index] ++> cells[next_row * self.grid_size + next_col];
                    }
                }
            }
        }
        visit cells[self.ignition_index];
    }

    can traverse with FireCell entry {
        if here.index not in self.seen {
            self.seen.append(here.index);
            visit [-->[?:FireCell]];
        }
    }

    can finish with Root exit {
        report {
            "arrivalMinutes": weighted_arrivals(
                self.rates,
                self.grid_size,
                self.cell_size_meters,
                self.ignition_index
            ),
            "traversedCellCount": len(self.seen)
        };
    }
}

