#!/bin/bash
#
# cleanup.sh - Remove agent run data
#
# Usage:
#   ./cleanup.sh              # Clean all run data
#   ./cleanup.sh --keep-playbook  # Keep playbook (learned strategies)
#   ./cleanup.sh --keep-skills    # Keep custom skills
#   ./cleanup.sh --all            # Remove everything including skills
#

AGENT_DATA_DIR="./agent_data"

# Parse arguments
KEEP_PLAYBOOK=false
KEEP_SKILLS=false

for arg in "$@"; do
  case $arg in
    --keep-playbook)
      KEEP_PLAYBOOK=true
      shift
      ;;
    --keep-skills)
      KEEP_SKILLS=true
      shift
      ;;
    --all)
      KEEP_PLAYBOOK=false
      KEEP_SKILLS=false
      shift
      ;;
    --help|-h)
      echo "Usage: ./cleanup.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --keep-playbook  Keep playbook (learned strategies)"
      echo "  --keep-skills    Keep custom skills"
      echo "  --all            Remove everything including skills"
      echo "  --help, -h       Show this help message"
      exit 0
      ;;
  esac
done

echo "🧹 Cleaning up agent run data..."

# Remove artifacts (run outputs)
if [ -d "$AGENT_DATA_DIR/artifacts" ]; then
  rm -rf "$AGENT_DATA_DIR/artifacts"/*
  echo "  ✓ Artifacts removed"
fi

# Remove sessions (event logs)
if [ -d "$AGENT_DATA_DIR/sessions" ]; then
  rm -rf "$AGENT_DATA_DIR/sessions"/*
  echo "  ✓ Sessions removed"
fi

# Remove memory
if [ -d "$AGENT_DATA_DIR/memory" ]; then
  rm -rf "$AGENT_DATA_DIR/memory"/*
  echo "  ✓ Memory removed"
fi

# Optionally remove playbook
if [ "$KEEP_PLAYBOOK" = false ] && [ -d "$AGENT_DATA_DIR/playbook" ]; then
  rm -rf "$AGENT_DATA_DIR/playbook"/*
  echo "  ✓ Playbook removed"
else
  echo "  ○ Playbook preserved"
fi

# Optionally remove skills
if [ "$KEEP_SKILLS" = false ] && [ -d "$AGENT_DATA_DIR/skills" ]; then
  rm -rf "$AGENT_DATA_DIR/skills"/*
  echo "  ✓ Skills removed"
else
  echo "  ○ Skills preserved"
fi

echo ""
echo "✅ Cleanup complete!"
echo ""
echo "Run data location: $AGENT_DATA_DIR"
