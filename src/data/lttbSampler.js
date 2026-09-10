/**
 * @module lttbSampler
 * @description Largest Triangle Three Buckets (LTTB) algorithm for perceptually lossless time-series downsampling.
 * 
 * LTTB reduces the number of data points while preserving visual characteristics that matter:
 * - Significant changes, peaks, and troughs
 * - Overall shape and trends
 * - Removes redundant points in flat sections
 * 
 * Based on: "Downsampling time series for visual representation" by Sveinn Steinarsson
 * Research-backed: 60-80% data reduction while maintaining visual fidelity
 */

/**
 * Calculate the area of a triangle formed by three points.
 * @param {number} x1 - X coordinate of first point
 * @param {number} y1 - Y coordinate of first point
 * @param {number} x2 - X coordinate of second point
 * @param {number} y2 - Y coordinate of second point
 * @param {number} x3 - X coordinate of third point
 * @param {number} y3 - Y coordinate of third point
 * @returns {number} Triangle area
 */
function triangleArea(x1, y1, x2, y2, x3, y3) {
  return Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2);
}

/**
 * Downsample time-series data using LTTB algorithm.
 * 
 * @param {Array<{x: number, y: number}>} data - Input data points with x (time) and y (value)
 * @param {number} threshold - Target number of output points (typically 800-2000)
 * @returns {Array<{x: number, y: number}>} Downsampled data
 */
export function lttbDownsample(data, threshold) {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.length <= threshold) return data;
  if (threshold < 3) return [data[0], data[data.length - 1]];

  const sampled = [];
  const bucketSize = (data.length - 2) / (threshold - 2);

  // Always include the first point
  sampled.push(data[0]);

  let a = 0; // Last selected point index

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate bucket range
    const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    
    // Calculate average of next bucket
    let avgX = 0;
    let avgY = 0;
    const avgRangeLength = avgRangeEnd - avgRangeStart;
    
    for (let j = avgRangeStart; j < avgRangeEnd && j < data.length; j++) {
      avgX += data[j].x;
      avgY += data[j].y;
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // Find the point in current bucket with largest triangle area
    const rangeStart = Math.floor(i * bucketSize) + 1;
    const rangeEnd = Math.floor((i + 1) * bucketSize) + 1;
    
    let maxArea = -1;
    let maxAreaPoint = data[rangeStart];
    
    const pointA = data[a];
    
    for (let j = rangeStart; j < rangeEnd && j < data.length; j++) {
      const pointB = data[j];
      const area = triangleArea(pointA.x, pointA.y, avgX, avgY, pointB.x, pointB.y);
      
      if (area > maxArea) {
        maxArea = area;
        maxAreaPoint = pointB;
      }
    }

    sampled.push(maxAreaPoint);
    a = rangeEnd - 1;
  }

  // Always include the last point
  sampled.push(data[data.length - 1]);

  return sampled;
}

/**
 * Adaptive sampling based on data variance.
 * Uses higher sampling rates for high-variance sections and lower rates for stable sections.
 * 
 * @param {Array<{x: number, y: number}>} data - Input data points
 * @param {number} baseThreshold - Base target number of points
 * @param {number} varianceThreshold - Variance threshold for adaptive sampling
 * @returns {Array<{x: number, y: number}>} Adaptively sampled data
 */
export function adaptiveVarianceSampling(data, baseThreshold, varianceThreshold = 0.1) {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (data.length <= baseThreshold) return data;

  // Calculate variance in sliding windows
  const windowSize = Math.min(50, Math.floor(data.length / 10));
  const variances = [];
  
  for (let i = 0; i < data.length - windowSize; i++) {
    const window = data.slice(i, i + windowSize);
    const values = window.map(p => p.y);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    variances.push(variance);
  }

  // Determine adaptive thresholds based on variance
  const avgVariance = variances.reduce((sum, v) => sum + v, 0) / variances.length;
  const highVarianceRegions = variances.map(v => v > avgVariance * varianceThreshold);

  // Apply higher sampling to high-variance regions
  const segments = [];
  let currentSegment = { start: 0, highVariance: highVarianceRegions[0] };
  
  for (let i = 1; i < highVarianceRegions.length; i++) {
    if (highVarianceRegions[i] !== currentSegment.highVariance) {
      currentSegment.end = i + windowSize;
      segments.push({ ...currentSegment });
      currentSegment = { start: i + windowSize, highVariance: highVarianceRegions[i] };
    }
  }
  currentSegment.end = data.length;
  segments.push(currentSegment);

  // Sample each segment with appropriate threshold
  const sampled = [];
  for (const segment of segments) {
    const segmentData = data.slice(segment.start, segment.end);
    const segmentThreshold = segment.highVariance 
      ? baseThreshold * 1.5 
      : baseThreshold * 0.5;
    const segmentSampled = lttbDownsample(segmentData, Math.floor(segmentThreshold));
    sampled.push(...segmentSampled);
  }

  return sampled;
}

/**
 * Multi-resolution pre-aggregation for time-series data.
 * Pre-computes multiple resolutions for efficient querying at different time ranges.
 * 
 * @param {Array<{x: number, y: number}>} data - Input data points
 * @returns {Map<string, Array<{x: number, y: number}>>} Map of resolution to downsampled data
 */
export function multiResolutionPreAggregate(data) {
  const resolutions = new Map();
  
  // Original data (1-second resolution equivalent)
  resolutions.set('1s', data);
  
  // Pre-compute common resolutions
  const thresholds = {
    '1min': Math.max(10, Math.floor(data.length / 60)),
    '5min': Math.max(10, Math.floor(data.length / 300)),
    '1hr': Math.max(10, Math.floor(data.length / 3600)),
    '1day': Math.max(10, Math.floor(data.length / 86400)),
  };

  for (const [resolution, threshold] of Object.entries(thresholds)) {
    if (data.length > threshold) {
      resolutions.set(resolution, lttbDownsample(data, threshold));
    }
  }

  return resolutions;
}

/**
 * Select appropriate resolution based on time range.
 * 
 * @param {Map<string, Array>} resolutions - Multi-resolution data
 * @param {number} timeRangeMs - Time range in milliseconds
 * @returns {string} Resolution key
 */
export function selectResolutionByTimeRange(resolutions, timeRangeMs) {
  if (timeRangeMs < 60 * 1000) return '1s'; // < 1 minute
  if (timeRangeMs < 5 * 60 * 1000) return '1min'; // < 5 minutes
  if (timeRangeMs < 60 * 60 * 1000) return '5min'; // < 1 hour
  if (timeRangeMs < 24 * 60 * 60 * 1000) return '1hr'; // < 1 day
  return '1day'; // >= 1 day
}
