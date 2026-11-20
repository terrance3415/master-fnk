from remaster.preflight import svt_logical_cores


def test_svt_log_line_accepts_v1_and_v2():
    old = "Svt[info]: Number of logical cores available: 2\n"
    new = (
        "Svt[warn]: logical_processors will be deprecated in v3.0. "
        "Use level_of_parallelism instead.\n"
        "Svt[info]: Level of Parallelism: 2\n"
    )
    assert svt_logical_cores(old) == 2
    assert svt_logical_cores(new) == 2
    assert svt_logical_cores("Svt[info]: Number of PPCS 74\n") is None
