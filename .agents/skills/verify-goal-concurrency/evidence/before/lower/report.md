# GoalConcurrency

TLC reached 16 states and 22 steps. The chart draws 13 states and 19 arrows.
The chart does not draw 3 steps that stay in one chart state.

## CompletionRecognized breaks
The shortest path has 5 steps:
0. Active: saved 0, target 2
Contribution ready; edit ready
1. a member reads the goal target: Active: saved 0, target 2
Contribution read; edit ready
2. the manager reads the goal: Active: saved 0, target 2
Contribution read; edit goal read
3. the manager reads the amount saved: Active: saved 0, target 2
Contribution read; edit total read
4. the contribution is saved; the earlier target is unmet: Active: saved 1, target 2
Contribution done; edit total read
5. the target and calculated status are saved: Active: saved 1, target 1
Contribution done; edit done

## Rules that hold
TypeOK, CompletionSound, NoDeadlock
