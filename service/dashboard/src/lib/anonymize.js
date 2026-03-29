// Shared anonymization — Activity Log, Treasury data dividend, export
export function anonymize(str) {
	if (!str) return str;
	return String(str)
		// Paths & usernames
		.replace(/[A-Z]:(\\\\|\\|\/)Users(\\\\|\\|\/)[^\\/"\s,}]+(\\\\|\\|\/)/gi, 'C:\\Users\\user\\')
		.replace(/\/home\/[^\/"\s,}]+\//gi, '/home/user/')
		// Emails
		.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]')
		// Phone numbers
		.replace(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{4,14})/g, '[phone]')
		// GPS coordinates (lat/lon with decimals)
		.replace(/[-+]?\d{1,3}\.\d{4,}/g, '[coord]')
		// IP addresses
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
		// SSN patterns
		.replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '[ssn]')
		// Credit card patterns
		.replace(/\b(?:\d{4}[-\s]?){3}\d{4}\b/g, '[card]')
		// JSON field values: address, gps, lat/lon/altitude
		.replace(/"addr(?:ess)?":\s*"[^"]*"/gi, '"address": "[address redacted]"')
		.replace(/"gps":\s*"[^"]*"/gi, '"gps": "[location redacted]"')
		.replace(/"latitude":\s*[-\d.]+/gi, '"latitude": 0')
		.replace(/"longitude":\s*[-\d.]+/gi, '"longitude": 0')
		.replace(/"altitude":\s*[-\d.]+/gi, '"altitude": 0')
		.replace(/"heading":\s*[-\d.]+/gi, '"heading": 0')
		// Street addresses in text
		.replace(/\b\d{1,5}\s+[\w\s]{2,25}\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|court|ct|way|place|pl)\b/gi, '[street address]')
		// addr= or addr: field values
		.replace(/addr[=:]\s*[^,\n\]}{]+/gi, 'addr=[address redacted]');
}
