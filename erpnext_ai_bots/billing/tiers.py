TIERS = {
    "Free": {
        "monthly_conversations": 20,
        "monthly_messages": 100,
        "monthly_tokens": 500_000,
        "max_tools": ["core.*"],
        "subagent_enabled": False,
        "price_usd": 0,
    },
    "Starter": {
        "monthly_conversations": 200,
        "monthly_messages": 2000,
        "monthly_tokens": 5_000_000,
        "max_tools": ["core.*", "accounting.*", "sales.*"],
        "subagent_enabled": False,
        "price_usd": 29,
    },
    "Professional": {
        "monthly_conversations": 2000,
        "monthly_messages": 20000,
        "monthly_tokens": 50_000_000,
        "max_tools": ["*"],
        "subagent_enabled": True,
        "price_usd": 99,
    },
    "Enterprise": {
        "monthly_conversations": -1,
        "monthly_messages": -1,
        "monthly_tokens": -1,
        "max_tools": ["*"],
        "subagent_enabled": True,
        "price_usd": 299,
    },
}
