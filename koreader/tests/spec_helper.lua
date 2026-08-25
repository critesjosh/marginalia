--- Assertions for the plugin's Lua specs. A failure is a Lua error, which the
--- harness turns into an ordinary test failure with a file and line.

local H = {}

function H.ok(condition, message)
    if not condition then
        error(message or "expected a truthy value", 3)
    end
end

function H.equal(actual, expected, message)
    if actual ~= expected then
        error(string.format("%s\n  expected: %s\n  actual:   %s",
            message or "values differ", tostring(expected), tostring(actual)), 3)
    end
end

function H.nil_(actual, message)
    if actual ~= nil then
        error(string.format("%s (got %s)", message or "expected nil", tostring(actual)), 3)
    end
end

function H.contains(haystack, needle, message)
    if type(haystack) ~= "string" or not haystack:find(needle, 1, true) then
        error(string.format("%s\n  looked for: %s", message or "substring not found", needle), 3)
    end
end

function H.absent(haystack, needle, message)
    if type(haystack) == "string" and haystack:find(needle, 1, true) then
        error(string.format("%s\n  unexpectedly found: %s", message or "substring present", needle), 3)
    end
end

--- A generator that hands out the given strings in turn, then repeats the last.
function H.sequence(...)
    local values = { ... }
    local index = 0
    return function()
        index = index + 1
        return values[math.min(index, #values)]
    end
end

return H
