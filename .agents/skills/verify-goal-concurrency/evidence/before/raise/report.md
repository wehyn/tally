# GoalConcurrency

TLC reached 17 states and 23 steps. The chart draws 13 states and 18 arrows.
The chart does not draw 4 steps that stay in one chart state.

## CompletionSound breaks
The shortest path has 5 steps:
0. Active: saved 0, target 1
Contribution ready; edit ready
1. a member reads the goal target: Active: saved 0, target 1
Contribution read; edit ready
2. the manager reads the goal: Active: saved 0, target 1
Contribution read; edit goal read
3. the manager reads the amount saved: Active: saved 0, target 1
Contribution read; edit total read
4. the target and calculated status are saved: Active: saved 0, target 2
Contribution read; edit done
5. the contribution is saved; the earlier target is met: Completed: saved 1, target 2
Contribution done; edit done

## Rules that hold
TypeOK, CompletionRecognized, NoDeadlock
